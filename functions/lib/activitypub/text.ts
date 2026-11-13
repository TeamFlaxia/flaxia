/// <reference types="@cloudflare/workers-types" />

/**
 * Text helpers shared by the ActivityPub builders.
 *
 * Federated content arrives as HTML and leaves as HTML, but Flaxia stores
 * plain text only. These helpers convert in both directions without pulling in
 * a DOM implementation (the Workers runtime has none) and without trusting
 * remote markup: tags are dropped, entities are decoded, and every outbound
 * fragment is escaped before it is re-inserted.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
};

/** Escape the five characters that must never appear raw in HTML text. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Decode the HTML entities that appear in real-world ActivityPub content. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Convert remote HTML into plain text.
 *
 * Script and style bodies are removed entirely (their text is code, not
 * content), block level tags become line breaks and every remaining tag is
 * dropped. Nothing from the remote document is ever interpreted as markup.
 */
export function htmlToText(html: string): string {
  const withoutCode = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutCode.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|li|blockquote|h[1-6])\s*>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  return decodeHtmlEntities(stripped)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g;
const MENTION_PATTERN = /@([a-zA-Z0-9_]{1,30})(?:@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))?/g;
const HASHTAG_PATTERN = /#([\p{L}\p{N}_]{1,50})/gu;

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Render Flaxia post text as the HTML body of a federated Note.
 *
 * The text is escaped first, so only the markup this function adds itself can
 * end up in the document. Links, mentions and hashtags become anchors.
 *
 * `mentionUrls` maps a handle (`alice` or `alice@remote.example`) to the
 * profile URL to link it to. Without an entry a mention links to the local
 * profile page, which is the right target for local accounts.
 */
export function textToHtml(text: string, baseUrl: string, mentionUrls?: Record<string, string>): string {
  const escaped = escapeHtml(text).replace(/\\\{/g, '{');
  const withLinks = escaped.replace(URL_PATTERN, (match) => {
    if (!isSafeUrl(match)) return match;
    return `<a href="${match}" rel="nofollow noopener noreferrer" target="_blank">${match}</a>`;
  });
  const withMentions = withLinks.replace(MENTION_PATTERN, (match, username: string, domain?: string) => {
    const handle = domain ? `@${username}@${domain}` : `@${username}`;
    const lookup = domain ? `${username}@${domain}` : username;
    const href = mentionUrls?.[lookup] ?? `${baseUrl}/users/${username}`;
    return `<span class="h-card"><a href="${href}" class="u-url mention">${handle}</a></span>`;
  });
  const withHashtags = withMentions.replace(HASHTAG_PATTERN, (match, tag: string) => {
    return `<a href="${baseUrl}/tags/${encodeURIComponent(tag)}" class="hashtag" rel="tag">#${tag}</a>`;
  });
  const paragraphs = withHashtags
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br />')}</p>`)
    .join('');
  return paragraphs;
}

/** Hashtags mentioned in a plain-text body. */
export function extractHashtags(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

/** Usernames mentioned in a plain-text body, without the remote domain. */
export function extractMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}
