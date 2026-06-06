'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { injectAds } from '@/lib/inject-ads';
import { openPostModal } from '@/lib/post-modal';
import type { Ad, Post, TimelineItem } from '@/types/post';
import { isAd } from '@/types/post';
import PostCard from '@/components/client/PostCard';

const PAGE_SIZE = 20;

interface TimelineState {
  mode: 'following' | 'foryou' | 'global';
  posts: TimelineItem[];
  ads: Ad[];
  everyN: number;
  cursor?: string;
  loading: boolean;
  hasMore: boolean;
}

function SkeletonCard() {
  return (
    <div className="post-card skeleton-card" style={{ padding: '1rem', opacity: 0.5 }}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
        <div
          style={{
            width: 40, height: 40, borderRadius: '50%',
            background: 'var(--border-color, #333)',
          }}
        />
        <div style={{ flex: 1 }}>
          <div
            style={{
              height: 14, width: '40%', background: 'var(--border-color, #333)',
              borderRadius: 4, marginBottom: 4,
            }}
          />
          <div
            style={{
              height: 12, width: '25%', background: 'var(--border-color, #333)',
              borderRadius: 4,
            }}
          />
        </div>
      </div>
      <div
        style={{
          height: 14, width: '100%', background: 'var(--border-color, #333)',
          borderRadius: 4, marginBottom: 4,
        }}
      />
      <div
        style={{
          height: 14, width: '70%', background: 'var(--border-color, #333)',
          borderRadius: 4,
        }}
      />
    </div>
  );
}

function AdCardComponent({ ad }: { ad: Ad }) {
  const adCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!adCardRef.current || !ad.script_url) return;
    const script = document.createElement('script');
    script.src = ad.script_url;
    script.async = true;
    adCardRef.current.appendChild(script);
    return () => { script.remove(); };
  }, [ad.script_url]);

  if (ad.ad_type === 'admax' && ad.script_url) {
    return (
      <div className="ad-banner" ref={adCardRef}>
        <div className="ad-label" style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>Ad</div>
      </div>
    );
  }

  return (
    <div className="ad-banner" style={{ position: 'relative' }}>
      {ad.thumbnail_key && (
        <img
          src={`/api/images/${ad.thumbnail_key}`}
          alt=""
          style={{ width: '100%', height: 'auto', display: 'block' }}
        />
      )}
      <div style={{ padding: '0.5rem 1rem' }}>
        <p style={{ margin: 0 }}>{ad.body_text}</p>
        {ad.click_url && (
          <a
            href={ad.click_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)', fontSize: '0.875rem' }}
          >
            Learn more
          </a>
        )}
      </div>
    </div>
  );
}

export function Timeline() {
  const { currentUser } = useAuth();
  const { t } = useI18n();

  const [state, setState] = useState<TimelineState>({
    mode: 'global',
    posts: [],
    ads: [],
    everyN: 8,
    loading: false,
    hasMore: true,
  });

  const [initialLoading, setInitialLoading] = useState(true);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const composerObserverRef = useRef<IntersectionObserver | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const buildApiUrl = useCallback((cursor?: string): string => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (cursor) params.set('cursor', cursor);
    if (stateRef.current.mode === 'following') {
      params.set('following', 'true');
    }
    if (stateRef.current.mode === 'following') {
      return `/api/posts?${params.toString()}`;
    }
    if (stateRef.current.mode === 'foryou') {
      return `/api/posts/recommended?${params.toString()}`;
    }
    return `/api/posts?${params.toString()}`;
  }, []);

  const loadAdConfig = useCallback(async () => {
    try {
      const [adsRes, configRes] = await Promise.all([
        fetch('/api/ads/active'),
        fetch('/api/admin/ads/config'),
      ]);
      const adsData = adsRes.ok ? (await adsRes.json()) as { ads: Ad[] } : { ads: [] };
      const configData = configRes.ok ? (await configRes.json()) as { every_n: number } : { every_n: 8 };
      setState(prev => ({ ...prev, ads: adsData.ads, everyN: configData.every_n }));
    } catch {
      // silently fail
    }
  }, []);

  const loadPosts = useCallback(async (cursor?: string) => {
    setState(prev => ({ ...prev, loading: true }));
    try {
      const url = buildApiUrl(cursor);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch posts');
      const data = (await res.json()) as { posts?: Post[] };
      const postsArray = Array.isArray(data.posts) ? data.posts : [];
      const postsWithAds = injectAds(postsArray, stateRef.current.ads, stateRef.current.everyN);

      setState(prev => {
        const existingPosts = cursor ? prev.posts : [];
        const newCursor = postsArray.length > 0 ? postsArray[postsArray.length - 1].created_at : undefined;
        return {
          ...prev,
          posts: [...existingPosts, ...postsWithAds],
          cursor: newCursor,
          hasMore: postsArray.length === PAGE_SIZE,
          loading: false,
        };
      });
    } catch (err) {
      console.error('Failed to load posts:', err);
      setState(prev => ({ ...prev, loading: false }));
    }
  }, [buildApiUrl]);

  const loadInitialPosts = useCallback(async () => {
    setInitialLoading(true);
    await Promise.all([loadPosts(), loadAdConfig()]);
    setInitialLoading(false);
  }, [loadPosts, loadAdConfig]);

  const loadMorePosts = useCallback(() => {
    if (stateRef.current.loading || !stateRef.current.hasMore || !stateRef.current.cursor) return;
    loadPosts(stateRef.current.cursor);
  }, [loadPosts]);

  const switchMode = useCallback((mode: 'following' | 'foryou' | 'global') => {
    if (stateRef.current.mode === mode) return;
    setState(prev => ({
      ...prev,
      mode,
      posts: [],
      cursor: undefined,
      hasMore: true,
      loading: false,
    }));
    Promise.all([loadPosts(), loadAdConfig()]);
  }, [loadPosts, loadAdConfig]);

  const reloadPosts = useCallback(() => {
    setState(prev => ({
      ...prev,
      posts: [],
      cursor: undefined,
      hasMore: true,
      loading: false,
    }));
    Promise.all([loadPosts(), loadAdConfig()]);
  }, [loadPosts, loadAdConfig]);

  useEffect(() => {
    loadInitialPosts();
  }, [loadInitialPosts]);

  useEffect(() => {
    if (!sentinelRef.current) return;
    if (observerRef.current) observerRef.current.disconnect();
    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !stateRef.current.loading && stateRef.current.hasMore) {
          loadMorePosts();
        }
      },
      { rootMargin: '300px', threshold: 0.1 },
    );
    observerRef.current.observe(sentinelRef.current);
    return () => { observerRef.current?.disconnect(); };
  }, [loadMorePosts, state.posts]);

  useEffect(() => {
    if (!composerRef.current || !fabRef.current) return;
    if (composerObserverRef.current) composerObserverRef.current.disconnect();
    composerObserverRef.current = new IntersectionObserver(
      (entries) => {
        fabRef.current?.classList.toggle('visible', !entries[0].isIntersecting);
      },
      { threshold: 0 },
    );
    composerObserverRef.current.observe(composerRef.current);
    return () => { composerObserverRef.current?.disconnect(); };
  }, [initialLoading]);

  useEffect(() => {
    const handlePostUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setState(prev => ({
        ...prev,
        posts: prev.posts.map(item => {
          if (isAd(item)) return item;
          if (item.id === detail.postId) {
            return {
              ...item,
              ...(detail.isFreshed !== undefined && { is_freshed: detail.isFreshed }),
              ...(detail.freshCount !== undefined && { fresh_count: detail.freshCount }),
              ...(detail.isBookmarked !== undefined && { is_bookmarked: detail.isBookmarked }),
              ...(detail.bookmarkCount !== undefined && { bookmark_count: detail.bookmarkCount }),
              ...(detail.replyCount !== undefined && { reply_count: detail.replyCount }),
            } as Post;
          }
          return item;
        }),
      }));
    };
    window.addEventListener('postUpdated', handlePostUpdated);
    return () => window.removeEventListener('postUpdated', handlePostUpdated);
  }, []);

  const handleNewPost = useCallback((post: Post) => {
    setState(prev => ({
      ...prev,
      posts: [post, ...prev.posts],
    }));
  }, []);

  const openPostModalFn = useCallback(() => {
    openPostModal({
      currentUser: currentUser ? { username: currentUser.username, id: currentUser.id, display_name: currentUser.display_name, avatar_key: currentUser.avatar_key } : undefined,
      onPostCreated: handleNewPost,
    });
  }, [currentUser, handleNewPost]);

  const handleDelete = useCallback((postId: string) => {
    setState(prev => ({
      ...prev,
      posts: prev.posts.filter(item => isAd(item) || item.id !== postId),
    }));
  }, []);

  return (
    <section className="timeline">
      <div className="timeline-header">
        <div className="feed-toggle">
          {currentUser && (
            <button
              className={`feed-toggle-btn ${state.mode === 'following' ? 'active' : ''}`}
              data-mode="following"
              onClick={() => switchMode('following')}
            >
              {t('timeline.following')}
            </button>
          )}
          <button
            className={`feed-toggle-btn ${state.mode === 'foryou' ? 'active' : ''}`}
            data-mode="foryou"
            onClick={() => switchMode('foryou')}
          >
            {t('timeline.for_you')}
          </button>
          <button
            className={`feed-toggle-btn ${state.mode === 'global' ? 'active' : ''}`}
            data-mode="global"
            onClick={() => switchMode('global')}
          >
            {t('timeline.global')}
          </button>
          <button
            className="feed-toggle-btn feed-reload-btn"
            title={t('timeline.reload_title')}
            onClick={reloadPosts}
          >
            {t('timeline.reload')}
          </button>
        </div>
      </div>

      {currentUser && (
        <div ref={composerRef} className="timeline-composer-placeholder" />
      )}

      <div className="post-list">
        {initialLoading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : state.posts.length === 0 && !state.loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            {t('timeline.no_posts')}
          </div>
        ) : (
          state.posts.map((item, index) => {
            if (isAd(item)) {
              return <AdCardComponent key={`ad-${item.id}-${index}`} ad={item} />;
            }
            return (
              <PostCard
                key={item.id}
                post={item}
                currentUser={currentUser ? { username: currentUser.username, id: currentUser.id, display_name: currentUser.display_name, avatar_key: currentUser.avatar_key } : null}
                sandboxOrigin={process.env.NEXT_PUBLIC_SANDBOX_ORIGIN || 'http://localhost:3001'}
                onDelete={handleDelete}
              />
            );
          })
        )}
      </div>

      <div className="load-more-container">
        <div
          ref={sentinelRef}
          className="load-more-sentinel"
          style={{ height: 100, display: state.hasMore ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center' }}
        >
          {state.loading && (
            <div className="loading-spinner" style={{ display: 'block', fontFamily: "'Noto Sans', monospace, sans-serif", fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              <div className="spinner" />
              <span>{t('common.loading')}</span>
            </div>
          )}
        </div>
      </div>

      {currentUser && (
        <button
          ref={fabRef}
          className="timeline-fab"
          onClick={openPostModalFn}
        >
          +
        </button>
      )}
    </section>
  );
}
