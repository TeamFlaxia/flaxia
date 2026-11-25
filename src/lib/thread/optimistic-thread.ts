// Short-lived snapshot of the post a user just clicked. PostCard has the full
// `Post` already, so the thread route can paint its root in the same frame
// instead of waiting for the thread API. The cache is intentionally tiny and
// one-shot: stale roots must never outlive the navigation they belong to.
//
// No SvelteKit imports here — the route load and the card both use this module
// on the client, and it stays importable in plain Node tests.
import type { Post } from '../../../shared/types/post.ts';

export const OPTIMISTIC_ROOT_LIMIT = 16;
export const OPTIMISTIC_ROOT_TTL_MS = 30_000;

interface Snapshot {
  post: Post;
  at: number;
}

const STORE_KEY = '__flaxiaOptimisticRoots';
type Store = Map<string, Snapshot>;

// Vite may put the card and the route load in separate chunks; parking the map
// on globalThis guarantees both chunks see the same snapshot.
function store(): Store {
  const scope = globalThis as typeof globalThis & { [STORE_KEY]?: Store };
  if (!scope[STORE_KEY]) scope[STORE_KEY] = new Map();
  return scope[STORE_KEY];
}

export function rememberPost(post: Post, now: number = Date.now()): void {
  if (!post?.id) return;
  const map = store();
  for (const [id, entry] of map) {
    if (now - entry.at > OPTIMISTIC_ROOT_TTL_MS) map.delete(id);
  }
  // Re-insert so the most recently clicked post is evicted last.
  map.delete(post.id);
  map.set(post.id, { post: { ...post }, at: now });
  while (map.size > OPTIMISTIC_ROOT_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function takeOptimisticRoot(id: string, now: number = Date.now()): Post | null {
  if (!id) return null;
  const map = store();
  const entry = map.get(id);
  if (!entry) return null;
  map.delete(id);
  if (now - entry.at > OPTIMISTIC_ROOT_TTL_MS) return null;
  return entry.post;
}

/** Test/route-reset hook; production navigation consumes entries one by one. */
export function clearOptimisticRoots(): void {
  store().clear();
}
