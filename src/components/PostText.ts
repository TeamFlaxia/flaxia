import type { MarkdownIt } from 'markdown-it';
import { canUsePostColors } from '../lib/entitlements.js';
import { parsePostColors } from '../lib/post-colors.js';
import {
  type ColorPlaceholderEntry,
  insertColorPlaceholders,
  restoreColorPlaceholders,
} from '../lib/post-colors-dom.js';
import { stripMediaCues } from '../lib/post-cues.js';
import { PostTextProps } from '../types/post.js';

// Configure markdown-it with security settings
let md: MarkdownIt | null = null;

// Cache for dynamic imports
let katexPromise: Promise<typeof import('katex')> | null = null;
let markdownitPromise: Promise<typeof import('markdown-it')> | null = null;
let dompurifyPromise: Promise<typeof import('dompurify')> | null = null;
let katexLoadingPromise: Promise<void> | null = null;

// Cache for custom emoji stamps
interface StampCacheEntry {
  name: string;
  url: string;
  user_id: string;
}
let stampCachePromise: Promise<Map<string, { url: string; user_id: string }>> | null = null;

async function getStampCache(): Promise<Map<string, { url: string; user_id: string }>> {
  if (!stampCachePromise) {
    stampCachePromise = fetch('/api/stamps/all', { credentials: 'include' })
      .then((r) => r.json() as Promise<{ stamps: StampCacheEntry[] }>)
      .then((data) => {
        const map = new Map<string, { url: string; user_id: string }>();
        for (const s of data.stamps) {
          map.set(s.name, { url: s.url, user_id: s.user_id });
        }
        return map;
      })
      .catch(() => new Map<string, { url: string; user_id: string }>());
  }
  return stampCachePromise;
}

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

export async function createPostText(props: PostTextProps): Promise<HTMLElement> {
  const container = document.createElement('div');
  // Markdown output already encodes line breaks as <br>; `white-space: pre-wrap`
  // is only for the plain-text placeholder, otherwise the literal newlines in
  // markdown-it's HTML double every break.
  container.className = 'post-text post-text--rich';

  // Process the text through the unified pipeline. Colors are an author-side
  // Flaxia+ entitlement; non-members' markers stay literal.
  const { html, colorEntries } = await processTextInternal(
    props.text,
    canUsePostColors({ badge_type: props.badgeType }),
  );
  container.innerHTML = html;
  restoreColorPlaceholders(container, colorEntries);

  // Render math elements after HTML is inserted
  renderMathElements(container);

  // Link URLs first so a `#fragment` stays inside the URL anchor, then link
  // hashtags while skipping anchors/code (see isExcludedTextParent).
  linkifyUrls(container);
  linkifyHashtags(container);
  linkifyMentions(container, props.mentions);
  if (props.enablePostRefs) {
    linkifyPostRefs(container);
  }

  await linkifyCustomEmoji(container, props.authorId);

  return container;
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

// Export processing functions for reuse
export {
  linkifyCustomEmoji,
  linkifyHashtags,
  linkifyMentions,
  linkifyPostRefs,
  linkifyUrls,
  processText,
  renderMathElements,
};

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
 * 7. Restore post references as literal text (linkified in createPostText)
 * 8. Restore color placeholders (in the DOM, see createPostText)
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

  // Step 7: Restore post references as plain text. createPostText() linkifies
  // them later, which keeps `>>N` inside code blocks literal.
  for (const ref of refPlaceholders) {
    const placeholderRegex = new RegExp(`⚡${ref.id}⚡`, 'g');
    // Escape the angle brackets: this string is inserted as HTML.
    html = html.replace(placeholderRegex, `&gt;&gt;${ref.index}`);
  }

  return { html, colorEntries };
}

/** HTML with colors disabled, for profile bios and legacy callers. */
async function processText(text: string): Promise<string> {
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

    // Debug: log if replacement happened
    if (before === restoredHtml) {
      console.warn(`Failed to replace math placeholder ${placeholder.id}`, before);
    }
  }

  return restoredHtml;
}

/**
 * Helper to create regex pattern that matches both quoted and &quot; patterns
 */
function _quotePattern(text: string): string {
  return `(?:${text}|&quot;${text}&quot;)`;
}

/**
 * Render all math elements in the container using KaTeX
 */
function renderMathElements(container: HTMLElement): void {
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
 * Linkifiers must not rewrite text inside links or code. Markdown links are
 * already anchors, and code blocks/spans are literal source.
 */
function isExcludedTextParent(parent: Node | null): boolean {
  const element = parent?.nodeType === 1 ? (parent as Element) : parent?.parentElement;
  return Boolean(element?.closest('a, code, pre'));
}

/**
 * Convert hashtags to clickable links
 */
function linkifyHashtags(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);

  const textNodes: Text[] = [];
  let node: Node | null;

  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  // Process text nodes and replace hashtags with links
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;

    if (!hashtagRegex.test(text)) continue;

    // Reset regex lastIndex
    hashtagRegex.lastIndex = 0;

    const parent = textNode.parentNode;
    if (!parent || isExcludedTextParent(parent)) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = hashtagRegex.exec(text)) !== null) {
      // Add text before hashtag
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      // Create hashtag link
      const hashtag = match[1];
      const span = document.createElement('span');
      span.className = 'hashtag-link';
      span.textContent = `#${hashtag}`;
      span.style.cursor = 'pointer';
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(hashtag)}`);
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore', tag: hashtag } }));
      });
      fragment.appendChild(span);

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    parent.replaceChild(fragment, textNode);
  }
}

/**
 * Convert URLs to clickable links
 */
function linkifyUrls(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);

  const textNodes: Text[] = [];
  let node: Node | null;

  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  // Process text nodes and replace URLs with links
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';

    // Regex to match URLs starting with https:// or www.
    const urlRegex = /(?:https?:\/\/|www\.)[^\s<>()]+/g;

    if (!urlRegex.test(text)) continue;

    // Reset regex lastIndex
    urlRegex.lastIndex = 0;

    const parent = textNode.parentNode;
    if (!parent || isExcludedTextParent(parent)) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlRegex.exec(text)) !== null) {
      // Add text before URL
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      // Create URL link
      let url = match[0];
      const displayUrl = url;

      // Add https:// if URL starts with www.
      if (url.startsWith('www.')) {
        url = 'https://' + url;
      }

      const link = document.createElement('a');
      link.href = url;
      link.className = 'url-link';
      link.textContent = displayUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      fragment.appendChild(link);

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    parent.replaceChild(fragment, textNode);
  }
}

async function linkifyCustomEmoji(container: HTMLElement, authorId?: string): Promise<void> {
  const stampCache = await getStampCache();
  if (stampCache.size === 0) return;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  // Match :name: format
  const emojiRegex = /:([a-zA-Z0-9_-]+):/g;

  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    if (!emojiRegex.test(text)) continue;

    emojiRegex.lastIndex = 0;

    const parent = textNode.parentNode;
    if (!parent || isExcludedTextParent(parent)) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = emojiRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      const stampName = match[0]; // e.g. ":hoge:"
      const stampData = stampCache.get(stampName);

      // For posts/chat: only render if stamp owner matches authorId
      // For reactions (authorId is undefined): always render
      if (stampData && (authorId === undefined || stampData.user_id === authorId)) {
        const img = document.createElement('img');
        img.src = stampData.url;
        img.alt = stampName;
        img.className = 'custom-emoji';
        img.title = stampName;
        fragment.appendChild(img);
      } else {
        fragment.appendChild(document.createTextNode(match[0]));
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    parent.replaceChild(fragment, textNode);
  }
}

/**
 * Build a map from username → user_id from the mentions JSON string
 */
function parseMentions(mentions?: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!mentions) return map;
  try {
    const data = JSON.parse(mentions) as Array<{ username: string; user_id: string }>;
    for (const m of data) {
      map.set(m.username.toLowerCase(), m.user_id);
    }
  } catch {}
  return map;
}

/**
 * Convert @username mentions to clickable links
 */
function linkifyMentions(container: HTMLElement, mentions?: string): void {
  const mentionMap = parseMentions(mentions);

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);

  const textNodes: Text[] = [];
  let node: Node | null;

  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  // Process text nodes and replace @mentions with links
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;

    if (!mentionRegex.test(text)) continue;

    // Reset regex lastIndex
    mentionRegex.lastIndex = 0;

    const parent = textNode.parentNode;
    if (!parent || isExcludedTextParent(parent)) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(text)) !== null) {
      // Add text before mention
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      // Create mention link only if user exists
      const username = match[1];
      const userExists = mentionMap.has(username.toLowerCase());
      if (userExists) {
        const span = document.createElement('span');
        span.className = 'mention-link';
        span.textContent = `@${username}`;
        span.style.cursor = 'pointer';
        span.addEventListener('click', (e) => {
          e.stopPropagation();
          window.history.pushState({}, '', `/profile/${encodeURIComponent(username)}`);
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'profile', username } }));
        });
        fragment.appendChild(span);
      } else {
        fragment.appendChild(document.createTextNode(`@${username}`));
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    parent.replaceChild(fragment, textNode);
  }
}

/**
 * Load KaTeX dynamically
 */
async function loadKaTeX(): Promise<void> {
  // Check if already loaded
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

/**
 * Convert >>(number) references to clickable links
 */
function linkifyPostRefs(container: HTMLElement): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);

  const textNodes: Text[] = [];
  let node: Node | null;

  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const postRefRegex = />>(\d+)/g;

    if (!postRefRegex.test(text)) continue;
    postRefRegex.lastIndex = 0;

    const parent = textNode.parentNode;
    if (!parent || isExcludedTextParent(parent)) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = postRefRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      const link = document.createElement('a');
      link.href = `#post-${match[1]}`;
      link.className = 'post-ref-link';
      link.textContent = `>>${match[1]}`;
      link.dataset.postIndex = match[1];
      fragment.appendChild(link);

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    parent.replaceChild(fragment, textNode);
  }
}
