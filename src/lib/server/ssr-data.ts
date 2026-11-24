import { type Bindings, handleApi } from '../../../functions/api/[[route]].ts';
import type { Post } from '../../../shared/types/post.ts';

// Server-only helpers for SSR loads. They call the Hono app in-process so the
// HTML and the client fetch share one response shape (no duplicated SQL).
const noopExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function apiJson<T>(path: string, request: Request, env: Bindings): Promise<T | null> {
  try {
    const url = new URL(path, request.url);
    const response = await handleApi(
      new Request(url, { method: 'GET', headers: request.headers }),
      env,
      noopExecutionContext,
    );
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export interface SsrFeed {
  posts: Post[];
  nextCursor?: string;
}

export async function loadFeed(request: Request, env: Bindings, limit = 20): Promise<SsrFeed> {
  const data = await apiJson<{ posts?: Post[]; next_cursor?: string }>(`/api/posts?limit=${limit}`, request, env);
  return { posts: data?.posts ?? [], nextCursor: data?.next_cursor };
}

export async function loadUserFeed(request: Request, env: Bindings, username: string, limit = 20): Promise<SsrFeed> {
  const data = await apiJson<{ posts?: Post[]; next_cursor?: string }>(
    `/api/posts?limit=${limit}&username=${encodeURIComponent(username)}`,
    request,
    env,
  );
  return { posts: data?.posts ?? [], nextCursor: data?.next_cursor };
}

export interface SsrThread {
  root: Post | null;
  replies: Post[];
}

export async function loadThread(request: Request, env: Bindings, id: string): Promise<SsrThread> {
  const data = await apiJson<{ root?: Post; replies?: Post[] }>(
    `/api/posts/${encodeURIComponent(id)}/thread`,
    request,
    env,
  );
  return { root: data?.root ?? null, replies: data?.replies ?? [] };
}

export interface SsrProfile {
  user: (Record<string, unknown> & { username?: string; display_name?: string | null; bio?: string | null }) | null;
}

export async function loadProfile(request: Request, env: Bindings, username: string): Promise<SsrProfile> {
  const data = await apiJson<{ user?: SsrProfile['user'] }>(`/api/users/${encodeURIComponent(username)}`, request, env);
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

export async function loadGames(request: Request, env: Bindings, limit = 30): Promise<SsrGame[]> {
  const data = await apiJson<{ games?: SsrGame[] }>(`/api/games?limit=${limit}`, request, env);
  return data?.games ?? [];
}
