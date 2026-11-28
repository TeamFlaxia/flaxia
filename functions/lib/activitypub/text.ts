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

/**
 * Mention pattern with a domain-aware second half.
 *
 * The leading boundary keeps the `@` of an email address (`foo@example.com`)
 * from being read as a mention; the trailing boundary keeps a partial username
 * from being linked. The optional domain uses the same shape as the lookup
 * endpoint accepts, so `@bob@example.com` is one token rather than `@bob`
 * followed by unrelated text.
 */
const MENTION_PATTERN =
  /(?<![\p{L}\p{N}_.@-])@([A-Za-z0-9_]{1,30})(?:@((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}))?(?![A-Za-z0-9_])/gu;
const HASHTAG_PATTERN = /#([\p{L}\p{N}_]{1,50})/gu;

/**
 * URLs, mentions and hashtags are tokenised in one pass. Running three
 * independent `String.replace` calls over an already-linked document lets the
 * mention regex rewrite `href="https://host/@bob"` attributes, which corrupts
 * the markup produced by the URL pass.
 */
const INLINE_TOKEN_PATTERN =
  /(?<url>https?:\/\/[^\s<>"']+)|(?<![\p{L}\p{N}_.@-])@(?<username>[A-Za-z0-9_]{1,30})(?:@(?<domain>(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}))?(?![A-Za-z0-9_])|(?<tag>#[\p{L}\p{N}_]{1,50})/gu;

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
  let linked = '';
  let lastIndex = 0;

  for (const match of escaped.matchAll(INLINE_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    linked += escaped.slice(lastIndex, index);
    lastIndex = index + match[0].length;
    const groups = match.groups ?? {};

    if (groups.url) {
      // The token is already escaped, so it can be reused in both the
      // attribute and the link text without a second escaping pass.
      if (!isSafeUrl(groups.url)) {
        linked += match[0];
        continue;
      }
      linked += `<a href="${groups.url}" rel="nofollow noopener noreferrer" target="_blank">${groups.url}</a>`;
      continue;
    }

    if (groups.username) {
      const username = groups.username;
      const domain = groups.domain;
      const handle = domain ? `@${username}@${domain}` : `@${username}`;
      // Mention keys are stored lower-cased by both buildNoteObject and
      // resolveMentions: `@Bob@Example.COM` must resolve like `@bob@example.com`.
      const lookup = (domain ? `${username}@${domain}` : username).toLowerCase();
      // Stored mention URLs come from a remote actor document: escape again
      // before placing them in an attribute.
      const mapped = mentionUrls?.[lookup];
      const href = escapeHtml(mapped ?? `${baseUrl}/users/${username}`);
      linked += `<span class="h-card"><a href="${href}" class="u-url mention">${handle}</a></span>`;
      continue;
    }

    if (groups.tag) {
      const tag = groups.tag.slice(1);
      const href = escapeHtml(`${baseUrl}/tags/${encodeURIComponent(tag)}`);
      linked += `<a href="${href}" class="hashtag" rel="tag">${groups.tag}</a>`;
    }
  }
  linked += escaped.slice(lastIndex);

  const paragraphs = linked
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
  return extractMentionHandles(text).map((handle) => handle.username);
}

/**
 * Mentions in a plain-text body, with the remote domain when present.
 *
 * Local mentions carry `domain: null`; a cross-instance `@user@domain` keeps
 * the domain so mention resolution can look the account up on its own server.
 */
export function extractMentionHandles(text: string): Array<{ username: string; domain: string | null }> {
  const found = new Map<string, { username: string; domain: string | null }>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const username = match[1];
    if (!username) continue;
    const domain = match[2] ? match[2].toLowerCase() : null;
    const key = domain ? `${username}@${domain}` : username;
    if (!found.has(key)) found.set(key, { username, domain });
  }
  return [...found.values()];
}
