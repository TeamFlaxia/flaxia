'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { openPostModal } from '@/lib/post-modal';
import type { Post } from '@/types/post';
import PostCard from '@/components/client/PostCard';

export default function BookmarksPage() {
  const { currentUser } = useAuth();
  const { t } = useI18n();
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ loading: false, hasMore: true, cursor: undefined as string | undefined });
  stateRef.current = { loading, hasMore, cursor };

  const sandboxOrigin = process.env.NEXT_PUBLIC_SANDBOX_ORIGIN || 'http://localhost:3001';

  const loadContent = useCallback(async (cursorVal?: string) => {
    if (stateRef.current.loading) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '10' });
      if (cursorVal) params.set('cursor', cursorVal);
      const res = await fetch(`/api/bookmarks?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      const data = (await res.json()) as { posts?: Post[] };
      const arr = Array.isArray(data.posts) ? data.posts : [];
      setPosts(prev => cursorVal ? [...prev, ...arr] : arr);
      if (arr.length > 0) setCursor(arr[arr.length - 1].created_at);
      setHasMore(arr.length === 10);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => { if (currentUser) loadContent(); else { setInitialLoading(false); setLoading(false); } }, [currentUser, loadContent]);

  useEffect(() => {
    if (!sentinelRef.current) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !stateRef.current.loading && stateRef.current.hasMore) {
        loadContent(stateRef.current.cursor);
      }
    }, { rootMargin: '300px', threshold: 0.1 });
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [loadContent]);

  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      setPosts(prev => prev.map(p => p.id === d.postId ? { ...p, ...d } : p));
    };
    window.addEventListener('postUpdated', h);
    return () => window.removeEventListener('postUpdated', h);
  }, []);

  const retry = useCallback(() => {
    setPosts([]); setCursor(undefined); setHasMore(true);
    loadContent();
  }, [loadContent]);

  const handleFab = useCallback(() => {
    openPostModal({ currentUser, onPostCreated: () => {} });
  }, [currentUser]);

  if (!currentUser) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
        {t('bookmarks.sign_in_required')}
      </div>
    );
  }

  return (
    <div className="bookmarks-page">
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)', borderBottom: '1px solid var(--border)', padding: '0.5rem 1rem' }}>
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>{t('bookmarks.title')}</h1>
      </div>

      <div className="post-list">
        {initialLoading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('common.loading')}</div>
        ) : error ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <div style={{ color: '#ef4444', marginBottom: '1rem' }}>{error}</div>
            <button onClick={retry} style={{ padding: '0.5rem 1rem', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', background: 'none', color: 'var(--text-primary)' }}>
              {t('common.retry')}
            </button>
          </div>
        ) : posts.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('bookmarks.empty')}</div>
        ) : (
          posts.map(p => (
            <PostCard key={p.id} post={p} sandboxOrigin={sandboxOrigin} currentUser={currentUser} />
          ))
        )}
      </div>

      <div ref={sentinelRef} style={{ height: 100, display: hasMore ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center' }}>
        {loading && <span style={{ color: 'var(--text-muted)' }}>{t('common.loading')}</span>}
      </div>

      <button onClick={handleFab} className="timeline-fab" style={{ position: 'fixed', bottom: '1.5rem', right: '1.5rem', width: 48, height: 48, borderRadius: '50%', background: 'var(--accent)', border: 'none', fontSize: '1.5rem', cursor: 'pointer', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
    </div>
  );
}
