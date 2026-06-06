'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/app/_providers/I18nContext';
import type { Post } from '@/types/post';
import PostCard from '@/components/client/PostCard';

interface UserPostListProps {
  username: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
}

export default function UserPostList({ username, currentUser }: UserPostListProps) {
  const { t } = useI18n();
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ loading: false, hasMore: true, cursor: undefined as string | undefined });
  stateRef.current = { loading, hasMore, cursor };

  const sandboxOrigin = process.env.NEXT_PUBLIC_SANDBOX_ORIGIN || 'http://localhost:3001';

  const loadPosts = useCallback(async (cursorVal?: string) => {
    if (stateRef.current.loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ username, limit: '20' });
      if (cursorVal) params.set('cursor', cursorVal);
      const res = await fetch(`/api/posts?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      const data = (await res.json()) as { posts: Post[] };
      const arr = Array.isArray(data.posts) ? data.posts : [];
      setPosts(prev => cursorVal ? [...prev, ...arr] : arr);
      if (arr.length > 0) setCursor(arr[arr.length - 1].created_at);
      setHasMore(arr.length === 20);
    } catch (err) { console.error(err); }
    finally { setLoading(false); setInitialLoading(false); }
  }, [username]);

  useEffect(() => { loadPosts(); }, [loadPosts]);

  useEffect(() => {
    if (!sentinelRef.current) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !stateRef.current.loading && stateRef.current.hasMore) {
        loadPosts(stateRef.current.cursor);
      }
    }, { rootMargin: '300px', threshold: 0.1 });
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [loadPosts]);

  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d?.postId) return;
      setPosts(prev => prev.map(p => p.id === d.postId ? {
        ...p,
        ...(d.isFreshed !== undefined && { is_freshed: d.isFreshed }),
        ...(d.freshCount !== undefined && { fresh_count: d.freshCount }),
        ...(d.isBookmarked !== undefined && { is_bookmarked: d.isBookmarked }),
        ...(d.bookmarkCount !== undefined && { bookmark_count: d.bookmarkCount }),
        ...(d.replyCount !== undefined && { reply_count: d.replyCount }),
      } as Post : p));
    };
    window.addEventListener('postUpdated', h);
    return () => window.removeEventListener('postUpdated', h);
  }, []);

  const handleDelete = useCallback((postId: string) => {
    setPosts(prev => prev.filter(p => p.id !== postId));
  }, []);

  if (initialLoading) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('common.loading')}</div>;
  }

  return (
    <div className="user-post-list">
      <div className="post-list">
        {posts.length === 0 ? (
          <p style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {t('profile.no_posts')}
          </p>
        ) : (
          posts.map(p => (
            <PostCard
              key={p.id}
              post={p}
              sandboxOrigin={sandboxOrigin}
              currentUser={currentUser}
              depth={p.depth}
              enablePostRefs
              onDelete={handleDelete}
            />
          ))
        )}
      </div>

      <div ref={sentinelRef} className="load-more-sentinel" style={{
        height: 100, width: '100%',
        display: hasMore ? 'flex' : 'none',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-muted)' }}>
            <div className="spinner" />
            <span style={{ fontSize: '0.875rem' }}>{t('common.loading')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
