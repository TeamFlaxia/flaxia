import type { PostVisibility } from '../../shared/types/post.ts';

export interface QuoteNotificationDecision {
  /** Whether the quoted author may receive a quote notification at all. */
  notify: boolean;
  /** Preview allowed in the push payload (never the private body). */
  pushPreview: string;
}

/**
 * Decide whether a quote notification may be delivered to the quoted author.
 *
 * `canReadPost` must come from the same visibility rule the read path uses
 * (GET /api/posts/:id), derived from database state — never from the request
 * body. Fails closed: a recipient who cannot read the post gets no quote
 * notification and no push. For followers-only/direct posts even an allowed
 * recipient gets metadata only, so a push cannot leak the private body.
 *
 * `public` and `unlisted` are readable by anyone, so quoting them keeps the
 * existing notification behaviour and text preview.
 */
export function quoteNotificationDecision(
  visibility: PostVisibility | string | null | undefined,
  canReadPost: boolean,
  text: string,
): QuoteNotificationDecision {
  if (!canReadPost) return { notify: false, pushPreview: '' };
  const restricted = visibility === 'private' || visibility === 'direct';
  return { notify: true, pushPreview: restricted ? '' : text };
}
