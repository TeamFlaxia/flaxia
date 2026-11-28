/**
 * Shared post-text presentation helpers.
 *
 * Locally authored posts are limited to 200 characters. Imported Fediverse
 * posts keep their full text (up to the storage cap enforced on ingest) and
 * are folded in the UI after the first 200 characters instead.
 */

/** Number of characters shown before a long remote post is folded. */
export const REMOTE_TEXT_PREVIEW_LENGTH = 200;

export interface PostTextFold {
  /** First `REMOTE_TEXT_PREVIEW_LENGTH` characters, safe to show on first paint. */
  preview: string;
  /** Everything after the preview; kept in memory until the reader expands it. */
  rest: string;
}

/**
 * Split a remote post body into its folded preview and remainder.
 *
 * Returns null when the text fits in the preview, so callers can leave short
 * posts (including every local post) on the existing rendering path. The cut
 * never splits a surrogate pair, e.g. an emoji on the 200th character.
 */
export function foldRemoteText(text: string): PostTextFold | null {
  if (text.length <= REMOTE_TEXT_PREVIEW_LENGTH) return null;
  let cut = REMOTE_TEXT_PREVIEW_LENGTH;
  const boundary = text.charCodeAt(cut - 1);
  const next = text.charCodeAt(cut);
  if (boundary >= 0xd800 && boundary <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut += 1;
  return { preview: text.slice(0, cut), rest: text.slice(cut) };
}

/** True when a post came from ActivityPub rather than a local author. */
export function isRemotePost(post: { is_remote?: boolean | number | null; actor_id?: string | null }): boolean {
  return Boolean(post.is_remote) || Boolean(post.actor_id);
}
