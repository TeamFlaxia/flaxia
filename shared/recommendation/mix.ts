// For You source policy. Kept in `shared/` so the Hono recommendation route and
// the Svelte client ranker apply exactly the same rule.

export type ForYouSource = 'local' | 'remote';

/**
 * A remote post is federated when it has an actor id, or when the author
 * decoration already marked it as remote. Local posts always have a real
 * `user_id` and no `actor_id`.
 */
export function isRemoteRecommendation(post: {
  is_remote?: boolean | number | null;
  actor_id?: string | null;
}): boolean {
  return Boolean(post.is_remote) || Boolean(post.actor_id);
}

function defaultSource<T>(item: T): ForYouSource {
  const post = item as { is_remote?: boolean | number | null; actor_id?: string | null };
  return isRemoteRecommendation(post) ? 'remote' : 'local';
}

/**
 * For You contains Flaxia posts only. Federated (Mastodon and other instances)
 * posts belong to the Federated tab, so they are dropped here — including from
 * the client-ranked candidate batch. Order is preserved and the result is
 * capped at `limit`.
 */
export function presentForYou<T>(
  posts: readonly T[],
  limit: number,
  getSource: (item: T) => ForYouSource = defaultSource,
): T[] {
  if (limit <= 0) return [];
  const result: T[] = [];
  for (const post of posts) {
    if (result.length >= limit) break;
    if (getSource(post) === 'local') result.push(post);
  }
  return result;
}
