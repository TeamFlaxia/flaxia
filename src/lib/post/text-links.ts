/**
 * DOM linkifiers for rendered post text.
 *
 * These helpers only decorate text nodes in an already-sanitized container;
 * they never parse Markdown. Keeping them separate from the Markdown/KaTeX
 * pipeline lets the Svelte text surface stay small and lets profile bios reuse
 * the exact same rules.
 */

// Cache for custom emoji stamps.
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

/**
 * Linkifiers must not rewrite text inside links or code. Markdown links are
 * already anchors, and code blocks/spans are literal source.
 */
function isExcludedTextParent(parent: Node | null): boolean {
  const element = parent?.nodeType === 1 ? (parent as Element) : parent?.parentElement;
  return Boolean(element?.closest('a, code, pre'));
}

function textNodesUnder(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }
  return textNodes;
}

/** Convert hashtags to clickable spans. */
export function linkifyHashtags(container: HTMLElement): void {
  for (const textNode of textNodesUnder(container)) {
    const text = textNode.textContent || '';
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;

    if (!hashtagRegex.test(text)) continue;

    hashtagRegex.lastIndex = 0;

    const parent = textNode.parentNode;
    if (!parent || isExcludedTextParent(parent)) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = hashtagRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

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

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    parent.replaceChild(fragment, textNode);
  }
}

/** Convert URLs to real anchors. */
export function linkifyUrls(container: HTMLElement): void {
  for (const textNode of textNodesUnder(container)) {
    const text = textNode.textContent || '';

    // Regex to match URLs starting with https:// or www.
    const urlRegex = /(?:https?:\/\/|www\.)[^\s<>()]+/g;

    if (!urlRegex.test(text)) continue;

    urlRegex.lastIndex = 0;

    const parent = textNode.parentNode;
    if (!parent || isExcludedTextParent(parent)) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

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

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    parent.replaceChild(fragment, textNode);
  }
}

/** Build a map from username → user_id from the mentions JSON string. */
export function parseMentions(mentions?: string): Map<string, string> {
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

/** Convert @username mentions to clickable spans for users that exist. */
export function linkifyMentions(container: HTMLElement, mentions?: string): void {
  const mentionMap = parseMentions(mentions);

  for (const textNode of textNodesUnder(container)) {
    const text = textNode.textContent || '';
    const mentionRegex = /@([a-zA-Z0-9_]{1,20})/g;

    if (!mentionRegex.test(text)) continue;

    mentionRegex.lastIndex = 0;

    const parent = textNode.parentNode;
    if (!parent || isExcludedTextParent(parent)) continue;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

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

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    parent.replaceChild(fragment, textNode);
  }
}

/** Convert custom `:stamp:` emoji to images owned by the post author. */
export async function linkifyCustomEmoji(
  container: HTMLElement,
  authorId?: string,
  shouldApply: () => boolean = () => true,
): Promise<void> {
  const stampCache = await getStampCache();
  if (stampCache.size === 0 || !shouldApply()) return;

  // Match :name: format
  const emojiRegex = /:([a-zA-Z0-9_-]+):/g;

  for (const textNode of textNodesUnder(container)) {
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

      const stampName = match[0];
      const stampData = stampCache.get(stampName);

      // For posts/chat: only render if stamp owner matches authorId.
      // For reactions (authorId is undefined): always render.
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

/** Convert >>N references to in-thread links. */
export function linkifyPostRefs(container: HTMLElement): void {
  for (const textNode of textNodesUnder(container)) {
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
