import type { MarkdownIt } from 'markdown-it';
import { parsePostColors } from '../../shared/post-colors.ts';
import { stripMediaCues } from '../../shared/post-cues.ts';
import type { PostTextProps } from '../../shared/types/post.ts';
import {
  linkifyCustomEmoji,
  linkifyHashtags,
  linkifyMentions,
  linkifyPostRefs,
  linkifyUrls,
} from '../lib/post/text-links.ts';
import {
  type ColorPlaceholderEntry,
  insertColorPlaceholders,
  restoreColorPlaceholders,
} from '../lib/post-colors-dom.ts';

/**
 * Pure text helpers for post bodies.
 *
 * This module owns the Markdown/Markdown-it + KaTeX + sanitizer pipeline and
 * re-exports the DOM linkifiers from `src/lib/post/text-links.ts`. It contains
 * no component factories: the Svelte surface (`PostText.svelte`) calls
 * `applyPostText()` and owns the element.
 */

// Configure markdown-it with security settings
let md: MarkdownIt | null = null;

// Cache for dynamic imports
let katexPromise: Promise<typeof import('katex')> | null = null;
let markdownitPromise: Promise<typeof import('markdown-it')> | null = null;
let dompurifyPromise: Promise<typeof import('dompurify')> | null = null;
let katexLoadingPromise: Promise<void> | null = null;

async function getMarkdownIt() {
  if (!md) {
    const MarkdownItModule = await getMarkdownItModule();
    md = new MarkdownItModule({
      html: false, // Disable raw HTML for security
      xhtmlOut: false,
      breaks: true, // Convert newlines to <br>
      linkify: false, // We'll handle links ourselves
      typographer: true,
    });
    // Disable all heading rules
    md.block.ruler.disable(['heading', 'lheading']);
  }
  return md;
}

async function getMarkdownItModule() {
  if (!markdownitPromise) {
    markdownitPromise = import('markdown-it');
  }
  const MarkdownItModule = await markdownitPromise;
  return MarkdownItModule.default;
}

async function getKatex() {
  if (!katexPromise) {
    katexPromise = import('katex');
  }
  return katexPromise;
}

async function getDOMPurify() {
  if (!dompurifyPromise) {
    dompurifyPromise = import('dompurify');
  }
  const mod = await dompurifyPromise;
  return mod.default;
}

interface MathPlaceholder {
  id: string;
  content: string;
  displayMode: boolean;
}

export interface ApplyPostTextOptions extends Pick<PostTextProps, 'text' | 'mentions' | 'enablePostRefs' | 'authorId'> {
  /** Post colors are an author-side Flaxia+ entitlement. */
  enableColors?: boolean;
}

/**
 * Render a post body into `container`.
 *
 * Colors are restored in the DOM (after sanitization) and math/linkifiers run
 * against the inserted HTML. `shouldApply` lets a component abort a stale
 * async render after its element was removed or its props changed.
 */
export async function applyPostText(
  container: HTMLElement,
  options: ApplyPostTextOptions,
  shouldApply: () => boolean = () => true,
): Promise<void> {
  const { html, colorEntries } = await processTextInternal(options.text, options.enableColors ?? false);
  if (!shouldApply()) return;

  container.innerHTML = html;
  restoreColorPlaceholders(container, colorEntries);

  // Render math elements after HTML is inserted.
  renderMathElements(container);

  // Link URLs first so a `#fragment` stays inside the URL anchor, then link
  // hashtags while skipping anchors/code (see isExcludedTextParent).
  linkifyUrls(container);
  linkifyHashtags(container);
  linkifyMentions(container, options.mentions);
  if (options.enablePostRefs) {
    linkifyPostRefs(container);
  }

  await linkifyCustomEmoji(container, options.authorId, shouldApply);
}

/**
 * Render a media cue body as inline-only Markdown + KaTeX (no blocks, links,
 * colors or mentions). Used by the media cue overlay; the returned HTML is
 * sanitized and still contains math placeholders — call renderMathElements()
 * on the host element after inserting it.
 */
export async function renderCueInlineHtml(text: string): Promise<string> {
  // Color markers inside a cue body are dropped, not rendered: cue text is
  // overlay-only and has no entitlement context.
  const { textWithPlaceholders, mathPlaceholders } = escapeMathNotation(parsePostColors(text).plain);
  const md = await getMarkdownIt();
  let html = md.renderInline(textWithPlaceholders);
  html = restoreMathPlaceholders(html, mathPlaceholders);
  const DOMPurify = await getDOMPurify();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['strong', 'em', 'code', 's', 'del', 'span', 'br'],
    ALLOWED_ATTR: ['class', 'data-math-content', 'data-math-display'],
    ALLOW_DATA_ATTR: true,
  });
}

// Pure DOM linkifiers live in a sibling module so profile bios can reuse them.
export {
  linkifyCustomEmoji,
  linkifyHashtags,
  linkifyMentions,
  linkifyPostRefs,
  linkifyUrls,
  parseMentions,
} from '../lib/post/text-links.ts';

/**
 * Unified text processing pipeline:
 * 0. Remove media cue lines (Niconico-style timed comments) — they are not
 *    part of the visible body
 * 1. Escape math notation → placeholders
 * 2. Escape color markers → placeholders (Flaxia+ authors only)
 * 3. Escape post references → placeholders
 * 4. Parse Markdown
 * 5. Sanitize HTML
 * 6. Expand KaTeX placeholders
 * 7. Restore post references as literal text (linkified by applyPostText)
 * 8. Restore color placeholders (in the DOM, see applyPostText)
 */
async function processTextInternal(
  text: string,
  enableColors: boolean,
): Promise<{ html: string; colorEntries: ColorPlaceholderEntry[] }> {
  // Step 0: cue lines are routed to the media overlay, never to the body.
  text = stripMediaCues(text);

  // Step 1: Escape math notation with placeholders
  const { textWithPlaceholders, mathPlaceholders } = escapeMathNotation(text);

  // Step 2: Color markers. Parse before the `>>N` substitution so a line that
  // starts with a post reference is treated as a block boundary here, matching
  // the API/SSR parser (which sees the raw body).
  let textForMarkdown = textWithPlaceholders;
  let colorEntries: ColorPlaceholderEntry[] = [];
  if (enableColors) {
    const parsed = parsePostColors(textForMarkdown);
    const inserted = insertColorPlaceholders(parsed.plain, parsed.spans);
    textForMarkdown = inserted.text;
    colorEntries = inserted.entries;
  }

  // Step 3: Escape post references (>>N) to prevent markdown blockquote parsing
  const refPlaceholders: { id: string; index: string }[] = [];
  textForMarkdown = textForMarkdown.replace(/>>(\d+)/g, (_match, index) => {
    const id = `ref-${refPlaceholders.length}`;
    refPlaceholders.push({ id, index });
    return `⚡${id}⚡`;
  });

  // Step 4: Parse Markdown (dynamically import markdown-it)
  const md = await getMarkdownIt();
  let html = md.render(textForMarkdown);

  // Step 5: Restore math placeholders BEFORE sanitization
  html = restoreMathPlaceholders(html, mathPlaceholders);

  // Step 6: Sanitize HTML (now with proper math placeholders)
  const DOMPurify = await getDOMPurify();
  html = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'code',
      'pre',
      'blockquote',
      'hr',
      'ul',
      'ol',
      'li',
      'a',
      'span',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      's',
      'del',
      'img',
    ],
    ALLOWED_ATTR: [
      'href',
      'target',
      'rel',
      'class',
      'data-math-content',
      'data-math-display',
      'data-post-index',
      'colspan',
      'rowspan',
      'src',
      'alt',
      'title',
    ],
    ALLOW_DATA_ATTR: true,
  });

  // Step 7: Restore post references as plain text. applyPostText() linkifies
  // them later, which keeps `>>N` inside code blocks literal.
  for (const ref of refPlaceholders) {
    const placeholderRegex = new RegExp(`⚡${ref.id}⚡`, 'g');
    // Escape the angle brackets: this string is inserted as HTML.
    html = html.replace(placeholderRegex, `&gt;&gt;${ref.index}`);
  }

  return { html, colorEntries };
}

/** HTML with colors disabled, for profile bios and legacy callers. */
export async function processText(text: string): Promise<string> {
  return (await processTextInternal(text, false)).html;
}

/**
 * Escape math notation ($...$ and $$...$$) with placeholders
 * to prevent markdown-it from interfering with math syntax
 */
function escapeMathNotation(text: string): { textWithPlaceholders: string; mathPlaceholders: MathPlaceholder[] } {
  const mathPlaceholders: MathPlaceholder[] = [];

  const escapeSegment = (segment: string): string => {
    // Match $$display math$$ or $inline math$. The inline form deliberately
    // rejects currency-like pairs such as `$5 and $10` (no whitespace adjacent
    // to the delimiters, and the closing `$` must not be followed by a digit).
    const mathRegex = /(?<!\\)\$\$([^$\n]+?)\$\$|(?<!\\)\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g;
    return segment.replace(mathRegex, (_match, displayContent, inlineContent) => {
      const content = displayContent || inlineContent;
      const displayMode = !!displayContent;
      const id = `math-${mathPlaceholders.length}`;

      mathPlaceholders.push({
        id,
        content: content.trim(),
        displayMode,
      });

      // Use special Unicode characters that won't be affected by Markdown parsing
      return `⚡${id}⚡`;
    });
  };

  // Code spans/fences are literal Markdown: a `$...$` inside them must stay as
  // source text rather than becoming a KaTeX node.
  const codePattern = /```[\s\S]*?```|`[^`\n]*`/g;
  let textWithPlaceholders = '';
  let lastIndex = 0;
  for (const match of text.matchAll(codePattern)) {
    const index = match.index ?? 0;
    textWithPlaceholders += escapeSegment(text.slice(lastIndex, index));
    textWithPlaceholders += match[0];
    lastIndex = index + match[0].length;
  }
  textWithPlaceholders += escapeSegment(text.slice(lastIndex));

  return { textWithPlaceholders, mathPlaceholders };
}

/**
 * Restore math placeholders with actual KaTeX render elements
 */
function restoreMathPlaceholders(html: string, mathPlaceholders: MathPlaceholder[]): string {
  let restoredHtml = html;

  for (const placeholder of mathPlaceholders) {
    // Match Unicode placeholders
    const placeholderRegex = new RegExp(`⚡${placeholder.id}⚡`, 'g');
    const before = restoredHtml;
    // Store content directly in the element for immediate rendering
    restoredHtml = restoredHtml.replace(
      placeholderRegex,
      `<span class="math-placeholder" data-math-content="${escapeHtml(placeholder.content)}" data-math-display="${placeholder.displayMode}"></span>`,
    );

    if (before === restoredHtml) {
      console.warn(`Failed to replace math placeholder ${placeholder.id}`, before);
    }
  }

  return restoredHtml;
}

/**
 * Render all math elements in the container using KaTeX
 */
export function renderMathElements(container: HTMLElement): void {
  const mathElements = container.querySelectorAll('.math-placeholder');

  // Load KaTeX if not already loaded or loading
  if (!window.katex) {
    if (!katexLoadingPromise) {
      katexLoadingPromise = loadKaTeX().catch((error) => {
        console.error('Failed to load KaTeX:', error);
        katexLoadingPromise = null; // Reset on error
      });
    }

    katexLoadingPromise.then(() => {
      mathElements.forEach((el) => void renderMathElement(el as HTMLElement));
    });
  } else {
    mathElements.forEach((el) => void renderMathElement(el as HTMLElement));
  }
}

/**
 * Render a single math element with KaTeX
 */
function renderMathElement(element: HTMLElement): void {
  const content = element.getAttribute('data-math-content') || '';
  const displayMode = element.getAttribute('data-math-display') === 'true';

  if (window.katex) {
    try {
      element.textContent = ''; // Clear existing content
      window.katex.render(unescapeHtml(content), element, {
        throwOnError: false,
        displayMode,
        output: 'mathml',
      });
      element.classList.remove('math-placeholder');
      element.classList.add(displayMode ? 'math-display' : 'math-inline');
    } catch (_error) {
      element.textContent = content;
      element.classList.add('math-error');
    }
  } else {
    element.textContent = content;
  }
}

/**
 * Load KaTeX dynamically
 */
async function loadKaTeX(): Promise<void> {
  if (window.katex) {
    return;
  }

  const katex = await getKatex();

  // Make katex available globally
  (window as unknown as Record<string, unknown>).katex = katex.default;
  katexLoadingPromise = null;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Unescape HTML entities
 */
function unescapeHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
}
