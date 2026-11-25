import type { Post } from '../../shared/types/post.ts';

// Universal load helpers. They use SvelteKit's `fetch`, which calls the Hono
// app in-process during SSR and the network API in the browser/native build.
// Keeping one code path means the static native build (ssr = false) still
// hydrates its route data from /api.
type Fetch = typeof fetch;

async function apiJson<T>(path: string, fetchFn: Fetch): Promise<T | null> {
  let response: Response;
  try {
    response = await fetchFn(path);
  } catch (error) {
    throw new Error(`SSR request to ${path} failed`, { cause: error });
  }
  // A missing post/profile is a legitimate 404; an outage is not. Returning
  // null for a 5xx would make load() throw a bogus "not found" instead of
  // reporting a server error, and would let crawlers index a false 404.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`SSR request to ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

export interface SsrFeed {
  posts: Post[];
  nextCursor?: string;
}

export async function loadFeed(fetchFn: Fetch, limit = 20): Promise<SsrFeed> {
  const data = await apiJson<{ posts?: Post[]; next_cursor?: string }>(`/api/posts?limit=${limit}`, fetchFn);
  return { posts: data?.posts ?? [], nextCursor: data?.next_cursor };
}

export async function loadUserFeed(fetchFn: Fetch, username: string, limit = 20): Promise<SsrFeed> {
  const data = await apiJson<{ posts?: Post[]; next_cursor?: string }>(
    `/api/posts?limit=${limit}&username=${encodeURIComponent(username)}`,
    fetchFn,
  );
  return { posts: data?.posts ?? [], nextCursor: data?.next_cursor };
}

export interface SsrThread {
  root: Post | null;
  replies: Post[];
}

export async function loadThread(fetchFn: Fetch, id: string): Promise<SsrThread> {
  const data = await apiJson<{ root?: Post; replies?: Post[] }>(`/api/posts/${encodeURIComponent(id)}/thread`, fetchFn);
  return { root: data?.root ?? null, replies: data?.replies ?? [] };
}

export interface SsrProfile {
  user: (Record<string, unknown> & { username?: string; display_name?: string | null; bio?: string | null }) | null;
}

export async function loadProfile(fetchFn: Fetch, username: string): Promise<SsrProfile> {
  const data = await apiJson<{ user?: SsrProfile['user'] }>(`/api/users/${encodeURIComponent(username)}`, fetchFn);
  return { user: data?.user ?? null };
}

export interface SsrGame {
  postId: string;
  title?: string;
  username?: string;
  thumbnailKey?: string | null;
  createdAt?: string;
  freshCount?: number;
  replyCount?: number;
}

export async function loadGames(fetchFn: Fetch, limit = 30): Promise<SsrGame[]> {
  const data = await apiJson<{ games?: SsrGame[] }>(`/api/games?limit=${limit}`, fetchFn);
  return data?.games ?? [];
}
