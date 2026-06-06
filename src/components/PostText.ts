import DOMPurify from 'dompurify';
import type MarkdownIt from 'markdown-it';
import { PostTextProps } from '../types/post.js';

// Configure markdown-it with security settings
let md: MarkdownIt | null = null;

// Cache for dynamic imports
let katexPromise: Promise<typeof import('katex')> | null = null;
let markdownitPromise: Promise<typeof import('markdown-it')> | null = null;
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

interface MathPlaceholder {
  id: string;
  content: string;
  displayMode: boolean;
}

export async function createPostText(props: PostTextProps): Promise<HTMLElement> {
  const container = document.createElement('div');
  container.className = 'post-text';

  // Process the text through the unified pipeline
  const processedHtml = await processText(props.text, props.enablePostRefs);
  container.innerHTML = processedHtml;

  // Render math elements after HTML is inserted
  renderMathElements(container);

  // Linkify hashtags and URLs
  linkifyHashtags(container);
  linkifyUrls(container);
  linkifyMentions(container, props.mentions);
  if (props.enablePostRefs) {
    linkifyPostRefs(container);
  }

  return container;
}

// Export processing functions for reuse
export { linkifyHashtags, linkifyMentions, linkifyPostRefs, linkifyUrls, processText, renderMathElements };

/**
 * Unified text processing pipeline:
 * 1. Escape math notation → placeholders
 * 2. Parse Markdown
 * 3. Sanitize HTML
 * 4. Expand KaTeX placeholders
 */
async function processText(text: string, enablePostRefs?: boolean): Promise<string> {
  // Step 1: Escape math notation with placeholders
  const { textWithPlaceholders, mathPlaceholders } = escapeMathNotation(text);

  // Step 1.5: Escape post references (>>N) to prevent markdown blockquote parsing
  const refPlaceholders: { id: string; index: string }[] = [];
  const textWithRefPlaceholders = textWithPlaceholders.replace(/>>(\d+)/g, (match, index) => {
    const id = `ref-${refPlaceholders.length}`;
    refPlaceholders.push({ id, index });
    return `⚡${id}⚡`;
  });

  // Step 2: Parse Markdown (dynamically import markdown-it)
  const md = await getMarkdownIt();
  let html = md.render(textWithRefPlaceholders);

  // Step 3: Restore math placeholders BEFORE sanitization
  html = restoreMathPlaceholders(html, mathPlaceholders);
  console.log('HTML before sanitization:', html);

  // Step 4: Sanitize HTML (now with proper math placeholders)
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
  console.log('HTML after sanitization:', html);

  // Step 4.5: Restore post reference placeholders as clickable links (or plain text)
  for (const ref of refPlaceholders) {
    const placeholderRegex = new RegExp(`⚡${ref.id}⚡`, 'g');
    const replacement = enablePostRefs
      ? `<a class="post-ref-link" href="#post-${ref.index}" data-post-index="${ref.index}">>>${ref.index}</a>`
      : `>>${ref.index}`;
    html = html.replace(placeholderRegex, replacement);
  }

  return html;
}

/**
 * Escape math notation ($...$ and $$...$$) with placeholders
 * to prevent markdown-it from interfering with math syntax
 */
function escapeMathNotation(text: string): { textWithPlaceholders: string; mathPlaceholders: MathPlaceholder[] } {
  const mathPlaceholders: MathPlaceholder[] = [];
  let placeholderId = 0;

  // Match $$display math$$ or $inline math$
  const mathRegex = /\$\$([^$]+)\$\$|\$([^$]+?)\$/g;

  const textWithPlaceholders = text.replace(mathRegex, (match, displayContent, inlineContent) => {
    const content = displayContent || inlineContent;
    const displayMode = !!displayContent;
    const id = `math-${placeholderId++}`;

    mathPlaceholders.push({
      id,
      content: content.trim(),
      displayMode,
    });

    // Use special Unicode characters that won't be affected by Markdown parsing
    return `⚡${id}⚡`;
  });

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
    if (!parent) continue;

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
    if (!parent) continue;

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
    if (!parent) continue;

    // Skip if parent is already a link (e.g. inside an <a> tag)
    if (parent.nodeName === 'A') continue;

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
    if (!parent) continue;

    if (parent.nodeName === 'A') continue;

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
