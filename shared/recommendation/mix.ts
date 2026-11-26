// For You source mixing. Kept in `shared/` so the Hono recommendation route and
// the Svelte client ranker apply exactly the same rule.

export type ForYouSource = 'local' | 'remote';

export interface ForYouMixOptions<T> {
  items: readonly T[];
  getSource: (item: T) => ForYouSource;
  limit: number;
  /** The user chose not to see federated posts in For You. */
  hideRemote?: boolean;
}

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

/**
 * Interleave local (Flaxia) and remote (fediverse) posts one by one.
 *
 * The local post takes the first slot of every pair — Flaxia priority. When
 * one side runs out, the remaining slots are filled from the other side so a
 * sparse side never leaves holes in the feed. With `hideRemote` the remote
 * side is dropped entirely and the result is all local.
 *
 * Order inside each side is preserved, so callers can rank first and mix last.
 */
export function mixForYouFeed<T>({ items, getSource, limit, hideRemote = false }: ForYouMixOptions<T>): T[] {
  if (limit <= 0 || items.length === 0) return [];

  const local: T[] = [];
  const remote: T[] = [];
  for (const item of items) {
    const source = getSource(item);
    if (source === 'local') local.push(item);
    else if (!hideRemote) remote.push(item);
  }

  const result: T[] = [];
  let localIndex = 0;
  let remoteIndex = 0;
  while (result.length < limit && (localIndex < local.length || remoteIndex < remote.length)) {
    if (localIndex < local.length) result.push(local[localIndex++]);
    if (result.length >= limit) break;
    if (remoteIndex < remote.length) result.push(remote[remoteIndex++]);
  }
  return result;
}

function defaultSource<T>(item: T): ForYouSource {
  const post = item as { is_remote?: boolean | number | null; actor_id?: string | null };
  return isRemoteRecommendation(post) ? 'remote' : 'local';
}

/**
 * Server-side presentation of a recommendation page. `mix=false` is used for
 * the client-ranked candidate batch, which applies the same mix after personal
 * re-ranking; `hideRemote` applies in both cases.
 */
export function presentForYou<T>(
  posts: readonly T[],
  limit: number,
  hideRemote: boolean,
  mix: boolean,
  getSource: (item: T) => ForYouSource = defaultSource,
): T[] {
  if (mix) return mixForYouFeed({ items: posts, getSource, limit, hideRemote });
  return hideRemote ? posts.filter((post) => getSource(post) === 'local') : [...posts];
}
