// Pure pagination helpers for the profile post list. The Svelte component owns
// rendering and the observer; these keep the feed URL and cursor fallback
// behavior testable.

export type UserPostSource = 'posts' | 'freshs' | 'bookmarks';

export interface UserPostPage<T> {
  posts: T[];
  next: string | undefined;
  more: boolean;
}

export function buildUserPostUrl(
  source: UserPostSource,
  username: string,
  cursor: string | undefined,
  limit: number,
): string {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  if (source === 'posts') {
    params.set('username', username);
    return `/api/posts?${params.toString()}`;
  }
  return `/${source === 'freshs' ? 'api/freshs' : 'api/bookmarks'}?${params.toString()}`;
}

/**
 * Normalize one API page. Newer responses send `nextCursor`; older ones only
 * send the rows, so the last `created_at` is the cursor and a full page means
 * there may be more.
 */
export function resolveUserPostPage<T extends { created_at: string }>(
  data: { posts?: readonly T[]; nextCursor?: string | null },
  limit: number,
): UserPostPage<T> {
  const posts = [...(data.posts ?? [])];
  if (data.nextCursor !== undefined) {
    const next = data.nextCursor || undefined;
    return { posts, next, more: Boolean(next) };
  }
  if (posts.length === 0) return { posts, next: undefined, more: false };
  return {
    posts,
    next: posts[posts.length - 1].created_at,
    more: posts.length === limit,
  };
}
