'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { openPostModal } from '@/lib/post-modal';
import type { Post } from '@/types/post';
import PostCard from '@/components/client/PostCard';

export default function ExplorePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentUser } = useAuth();
  const { t } = useI18n();

  const tagParam = searchParams.get('tag') || '';
  const [searchQuery, setSearchQuery] = useState(tagParam ? `#${tagParam}` : '');
  const [activeTag, setActiveTag] = useState(tagParam);
  const [posts, setPosts] = useState<Post[]>([]);
  const [trendingTags, setTrendingTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ loading: false, hasMore: true, cursor: undefined as string | undefined, activeTag: '' });
  stateRef.current = { loading, hasMore, cursor, activeTag };
  const [suggestions, setSuggestions] = useState<Array<{ type: 'tag' | 'user'; label: string }>>([]);
  const suggestTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);

  const sandboxOrigin = process.env.NEXT_PUBLIC_SANDBOX_ORIGIN || 'http://localhost:3001';

  const loadTrendingTags = useCallback(async () => {
    try {
      const res = await fetch('/api/tags/trending');
      if (res.ok) {
        const data = (await res.json()) as { tags: Array<{ tag: string; count: number }> };
        setTrendingTags(data.tags || []);
      }
    } catch {}
  }, []);

  const loadPosts = useCallback(async (tag?: string, cursorVal?: string) => {
    if (stateRef.current.loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '10' });
      if (cursorVal) params.set('cursor', cursorVal);
      const url = tag
        ? `/api/posts?hashtag=${encodeURIComponent(tag)}&${params.toString()}`
        : `/api/posts/trending?${params.toString()}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed');
      const data = (await res.json()) as { posts?: Post[] };
      const arr = Array.isArray(data.posts) ? data.posts : [];
      setPosts(prev => cursorVal ? [...prev, ...arr] : arr);
      if (arr.length > 0) setCursor(arr[arr.length - 1].created_at);
      setHasMore(arr.length === 10);
    } catch (err) { console.error(err); }
    finally { setLoading(false); setInitialLoading(false); }
  }, []);

  useEffect(() => { loadTrendingTags(); loadPosts(activeTag); }, []);

  useEffect(() => {
    if (!sentinelRef.current) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !stateRef.current.loading && stateRef.current.hasMore) {
        loadPosts(stateRef.current.activeTag || undefined, stateRef.current.cursor);
      }
    }, { rootMargin: '300px', threshold: 0.1 });
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [loadPosts]);

  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      setPosts(prev => prev.map(p => p.id === d.postId ? { ...p, ...d } : p));
    };
    window.addEventListener('postUpdated', h);
    return () => window.removeEventListener('postUpdated', h);
  }, []);

  const handleSearchInput = useCallback((value: string) => {
    setSearchQuery(value);
    clearTimeout(suggestTimeoutRef.current);
    abortRef.current?.abort();
    if (value.startsWith('#') && value.length > 1) {
      const prefix = value.slice(1);
      suggestTimeoutRef.current = setTimeout(async () => {
        const ac = new AbortController();
        abortRef.current = ac;
        try {
          const [tagsRes, usersRes] = await Promise.all([
            fetch(`/api/tags/suggest?q=${encodeURIComponent(prefix)}&limit=5`, { signal: ac.signal }),
            fetch(`/api/users/suggest?q=${encodeURIComponent(prefix)}&limit=5`, { signal: ac.signal }),
          ]);
          const tagData = tagsRes.ok ? (await tagsRes.json()) as { tags?: Array<{ tag: string }> } : {};
          const userData = usersRes.ok ? (await usersRes.json()) as { users?: Array<{ username: string }> } : {};
          const s: Array<{ type: 'tag' | 'user'; label: string }> = [];
          (tagData.tags || []).forEach((tag: { tag: string }) => s.push({ type: 'tag', label: tag.tag }));
          (userData.users || []).forEach((u: { username: string }) => s.push({ type: 'user', label: u.username }));
          setSuggestions(s);
        } catch {}
      }, 200);
    } else { setSuggestions([]); }
  }, []);

  const handleSuggestionClick = useCallback((s: { type: string; label: string }) => {
    if (s.type === 'tag') {
      setActiveTag(s.label);
      setSearchQuery(`#${s.label}`);
      setSuggestions([]);
      setPosts([]); setCursor(undefined); setHasMore(true);
      router.replace(`/explore?tag=${encodeURIComponent(s.label)}`);
      loadPosts(s.label);
    } else {
      router.push(`/users/${s.label}`);
    }
  }, [router, loadPosts]);

  const handleTagClick = useCallback((tag: string) => {
    setActiveTag(tag);
    setSearchQuery(`#${tag}`);
    setPosts([]); setCursor(undefined); setHasMore(true);
    router.replace(`/explore?tag=${encodeURIComponent(tag)}`);
    loadPosts(tag);
  }, [router, loadPosts]);

  const handleBack = useCallback(() => {
    setActiveTag('');
    setSearchQuery('');
    setPosts([]); setCursor(undefined); setHasMore(true);
    router.replace('/explore');
    loadPosts();
  }, [router, loadPosts]);

  const handleFab = useCallback(() => {
    openPostModal({ currentUser, onPostCreated: () => {} });
  }, [currentUser]);

  return (
    <div className="explore-page">
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)' }}>
        {activeTag && (
          <div style={{ display: 'flex', alignItems: 'center', padding: '0.5rem' }}>
            <button onClick={handleBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', padding: '0.25rem 0.5rem' }}>&larr;</button>
            <span style={{ fontWeight: 600, marginLeft: '0.5rem' }}>#{activeTag}</span>
          </div>
        )}
        <div style={{ padding: '0.5rem', position: 'relative' }}>
          <input
            value={searchQuery}
            onChange={e => handleSearchInput(e.target.value)}
            placeholder={t('explore.search_placeholder')}
            style={{ width: '100%', padding: '0.5rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
          />
          {suggestions.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: '0.5rem', right: '0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, zIndex: 20 }}>
              {suggestions.map((s, i) => (
                <div key={i} onClick={() => handleSuggestionClick(s)} style={{ padding: '0.5rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span>{s.type === 'tag' ? '#' : '@'}</span>
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {!activeTag && trendingTags.length > 0 && (
        <div style={{ padding: '0.5rem 1rem' }}>
          <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>{t('explore.trending_tags')}</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {trendingTags.map(tag => (
              <button
                key={tag.tag}
                onClick={() => handleTagClick(tag.tag)}
                style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 9999, padding: '0.25rem 0.75rem', cursor: 'pointer',
                  fontSize: '0.875rem',
                }}
              >
                #{tag.tag}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="post-list">
        {initialLoading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('common.loading')}</div>
        ) : posts.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('explore.no_posts')}</div>
        ) : (
          posts.map(p => (
            <PostCard key={p.id} post={p} sandboxOrigin={sandboxOrigin} currentUser={currentUser} />
          ))
        )}
      </div>

      <div ref={sentinelRef} style={{ height: 100, display: hasMore ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center' }}>
        {loading && <span style={{ color: 'var(--text-muted)' }}>{t('common.loading')}</span>}
      </div>

      {currentUser && (
        <button onClick={handleFab} className="timeline-fab visible" style={{ position: 'fixed', bottom: '1.5rem', right: '1.5rem', width: 48, height: 48, borderRadius: '50%', background: 'var(--accent)', border: 'none', fontSize: '1.5rem', cursor: 'pointer', zIndex: 100 }}>+</button>
      )}
    </div>
  );
}
