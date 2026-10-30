/**
 * DOM helpers for post text colors.
 *
 * Color markers are converted to placeholder tokens before Markdown runs, then
 * restored after sanitization. Placeholders are replaced with empty marker
 * elements first so a span can wrap Markdown elements (`{red}**bold**{/red}`)
 * without splitting a text node.
 */

import { type PostColorSpan, type PostTextStyle, postTextStyleClass } from './post-colors.js';

const TOKEN_START = '\uE000';
const TOKEN_END = '\uE001';
const TOKEN_RE = /\uE000(\/?c\d+)\uE001/g;

export interface ColorPlaceholderEntry {
  style: PostTextStyle;
  depth: number;
}

export interface ColorPlaceholderResult {
  text: string;
  entries: ColorPlaceholderEntry[];
}

/** Replace color span boundaries with placeholder tokens, preserving nesting. */
export function insertColorPlaceholders(plain: string, spans: PostColorSpan[]): ColorPlaceholderResult {
  // Empty spans have no visible content; their markers were already removed
  // from `plain`, so dropping them here keeps the token stream balanced.
  const visible = spans.filter((span) => span.end > span.start);
  if (visible.length === 0) return { text: plain, entries: [] };

  const events: Array<{ offset: number; kind: 'open' | 'close'; id: number; depth: number }> = [];
  visible.forEach((span, id) => {
    events.push({ offset: span.start, kind: 'open', id, depth: span.depth });
    events.push({ offset: span.end, kind: 'close', id, depth: span.depth });
  });

  events.sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    // Close before opening at the same boundary so adjacent spans stay siblings.
    if (a.kind !== b.kind) return a.kind === 'close' ? -1 : 1;
    // Inner closes first; outer opens first.
    return a.kind === 'close' ? b.depth - a.depth : a.depth - b.depth;
  });

  let text = '';
  let position = 0;
  for (const event of events) {
    text += plain.slice(position, event.offset);
    text += `${TOKEN_START}${event.kind === 'open' ? 'c' : '/c'}${event.id}${TOKEN_END}`;
    position = event.offset;
  }
  text += plain.slice(position);

  return {
    text,
    entries: visible.map((span) => ({ style: span.style, depth: span.depth })),
  };
}

function replaceTokenTextNodes(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node as Text).data.includes(TOKEN_START)) textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    const text = textNode.data;
    TOKEN_RE.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TOKEN_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const marker = document.createElement('span');
      marker.setAttribute('data-color-token', match[1]);
      fragment.appendChild(marker);
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}

function removeLeftoverTokens(root: HTMLElement): void {
  root.querySelectorAll('[data-color-token]').forEach((marker) => {
    marker.remove();
  });

  // A marker that ended up inside an attribute (for example a Markdown link
  // destination) is never restored. Remove the token so it cannot leak into a
  // rendered URL or class name.
  root.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (!attribute.value.includes(TOKEN_START)) continue;
      attribute.value = attribute.value.replace(TOKEN_RE, '');
    }
  });
}

/** Restore placeholder tokens in `container` as nested color spans. */
export function restoreColorPlaceholders(container: HTMLElement, entries: ColorPlaceholderEntry[]): void {
  if (entries.length === 0) return;

  replaceTokenTextNodes(container);

  const order = entries.map((entry, id) => ({ id, depth: entry.depth })).sort((a, b) => a.depth - b.depth);

  for (const { id } of order) {
    const open = container.querySelector<HTMLElement>(`[data-color-token="c${id}"]`);
    const close = container.querySelector<HTMLElement>(`[data-color-token="/c${id}"]`);
    if (!open || !close) continue;
    if (!(open.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;

    const range = document.createRange();
    range.setStartAfter(open);
    range.setEndBefore(close);

    const fragment = range.extractContents();
    const span = document.createElement('span');
    span.className = postTextStyleClass(entries[id].style);
    span.appendChild(fragment);
    range.insertNode(span);

    open.remove();
    close.remove();
  }

  removeLeftoverTokens(container);
}

/** Build a fragment of colorized plain text (used by quote cards). */
export function renderColorizedText(text: string, spans: PostColorSpan[]): DocumentFragment {
  const container = document.createElement('div');
  const { text: tokenized, entries } = insertColorPlaceholders(text, spans);
  container.textContent = tokenized.replace(/\\\{/g, '{');
  restoreColorPlaceholders(container, entries);

  const fragment = document.createDocumentFragment();
  while (container.firstChild) fragment.appendChild(container.firstChild);
  return fragment;
}
