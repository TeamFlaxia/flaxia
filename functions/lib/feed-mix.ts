/**
 * Origin-aware mixing for algorithmic feeds.
 *
 * Remote ActivityPub posts (`user_id = ''` and an `actor_id`) and local
 * Flaxia posts live in the same `posts` table. This helper interleaves the
 * two ranked streams so the delivered feed keeps an external : Flaxia ratio
 * of 1:1 while each side stays in its own relevance order.
 *
 * The same function is used by every non-vector recommendation path so the
 * server feed, the client-ranked candidate batch and the chronological
 * archive fallback all mix the two origins the same way. Vector similarity is
 * intentionally not re-weighted here.
 */

export type FeedOrigin = 'local' | 'external';

export interface FeedMixOptions {
  /**
   * Maximum posts from one author. A remote author is identified by
   * `actor_id`, not by the shared empty `user_id`, so posts from different
   * remote actors do not compete for the same quota.
   */
  maxPerAuthor?: number;
  /** Origin that takes the first slot. Defaults to `local`. */
  first?: FeedOrigin;
}

export interface FeedMixResult<T> {
  items: T[];
  /**
   * Origin that should take the first slot on the next page. Carrying this in
   * the pagination cursor keeps the 1:1 pattern across page boundaries.
   */
  nextOrigin: FeedOrigin;
}

/** The origin of a post row, before or after remote author decoration. */
export function feedOrigin(post: Record<string, unknown>): FeedOrigin {
  const actorId = post.actor_id;
  if (typeof actorId === 'string' && actorId.length > 0) return 'external';
  // Remote posts are stored with `user_id = ''`; local posts always have the
  // id of the account that wrote them.
  return String(post.user_id ?? '') === '' ? 'external' : 'local';
}

/** Stable per-author key used for the diversity cap. */
export function feedAuthorKey(post: Record<string, unknown>): string {
  const actorId = post.actor_id;
  if (typeof actorId === 'string' && actorId.length > 0) return `actor:${actorId}`;
  const userId = String(post.user_id ?? '');
  if (userId) return `user:${userId}`;
  const username = String(post.username ?? '');
  return username ? `remote:${username}` : '';
}

const opposite = (origin: FeedOrigin): FeedOrigin => (origin === 'local' ? 'external' : 'local');

/**
 * Interleave an already ranked list into a 1:1 external/local feed.
 *
 * Order within each origin is preserved. When one origin runs out (or every
 * remaining post from it hits the per-author cap), the other side fills the
 * rest so no content is lost. The returned `nextOrigin` is the slot the next
 * page should start with.
 */
export function mixFeedOrigins<T>(
  ranked: readonly T[],
  getPost: (item: T) => Record<string, unknown>,
  limit: number,
  options: FeedMixOptions = {},
): FeedMixResult<T> {
  const first = options.first ?? 'local';
  if (limit <= 0 || ranked.length === 0) return { items: [], nextOrigin: first };

  const queues: Record<FeedOrigin, T[]> = { local: [], external: [] };
  for (const item of ranked) queues[feedOrigin(getPost(item))].push(item);

  const indices: Record<FeedOrigin, number> = { local: 0, external: 0 };
  const authorCounts = new Map<string, number>();
  const maxPerAuthor = options.maxPerAuthor ?? Number.POSITIVE_INFINITY;
  const items: T[] = [];

  const take = (origin: FeedOrigin): T | null => {
    const queue = queues[origin];
    let index = indices[origin];
    while (index < queue.length) {
      const item = queue[index++];
      const author = feedAuthorKey(getPost(item));
      if (author && maxPerAuthor !== Number.POSITIVE_INFINITY) {
        const count = authorCounts.get(author) ?? 0;
        if (count >= maxPerAuthor) continue;
        authorCounts.set(author, count + 1);
      }
      indices[origin] = index;
      return item;
    }
    indices[origin] = index;
    return null;
  };

  let preferred = first;
  let last: FeedOrigin | null = null;
  while (items.length < limit) {
    let chosen = preferred;
    let item = take(preferred);
    if (!item) {
      chosen = opposite(preferred);
      item = take(chosen);
      if (!item) break;
    }
    items.push(item);
    last = chosen;
    preferred = opposite(chosen);
  }

  return { items, nextOrigin: last ? opposite(last) : first };
}
