<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import {
  decodeVector,
  type EncodedVector,
  RECOMMENDATION_VECTOR_DIM,
} from '../../../shared/recommendation/vector-codec.ts';
import { type Ad, isAd, type Post, type TimelineItem } from '../../../shared/types/post.ts';
import { createFabButton as makeFabButton } from '../fab-button.ts';
import { t } from '../i18n.ts';
import { injectAds } from '../inject-ads.ts';
import { isModalOpen } from '../modal-state.ts';
import { navigate } from '../navigation.ts';
import { openPostModal } from '../post-modal.ts';
import { rankCandidates } from '../recommendation/rank.ts';
import {
  DATA_SAVER_AD_SPACING_MULTIPLIER,
  getForYouBatchSize,
  getTimelinePageSize,
  isDataSaverEnabled,
} from '../settings.ts';
import CardHost from '../timeline/CardHost.svelte';
import type { CardOptions } from '../timeline/cards.ts';
import { getRecommendationProfile, type RecommendationProfile } from '../vault/recommendation-profile.ts';
import Composer from './Composer.svelte';

interface Props {
  sandboxOrigin: string;
  currentUser: {
    username: string;
    id: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
}

let { sandboxOrigin, currentUser = null }: Props = $props();

type Mode = 'foryou' | 'following' | 'global';

let root: HTMLDivElement;
let postList: HTMLDivElement;
let fabHost: HTMLDivElement;
let hashtagInput: HTMLInputElement;
let mode = $state<Mode>('foryou');
let items = $state<TimelineItem[]>([]);
let ads = $state<Ad[]>([]);
let everyN = $state(8);
let cursor: string | undefined;
let loading = $state(false);
// First paint must reserve feed height; `loading` is false until the ad race
// resolves, so the empty state would otherwise flash at height 0 (CLS).
let loadedOnce = $state(false);
let hasMore = $state(true);
let errorMessage = $state('');
let hashtag = $state('');
let forYouQueue: Post[] = [];
let forYouProfile: RecommendationProfile | null = null;
let seenIds = new Set<string>();
let generation = 0;
let destroyed = false;
let fabButton: HTMLElement | null = null;
let disposePostCreated: (() => void) | null = null;
let loadSentinel: HTMLDivElement;
let observer: IntersectionObserver | null = null;
let fabObserver: IntersectionObserver | null = null;
let boundModeShortcut: ((e: KeyboardEvent) => void) | null = null;

const cardOptions = $derived<CardOptions>({
  sandboxOrigin,
  currentUser,
  onDelete: (postId: string) => {
    items = items.filter((item) => !isAd(item) && item.id !== postId);
  },
});

function saveDataFetchInit(): RequestInit {
  return {
    credentials: 'include',
    ...(isDataSaverEnabled() ? { headers: { 'Save-Data': 'on' } } : {}),
  };
}

function buildApiUrl(pageCursor?: string): string {
  const params = new URLSearchParams();
  params.set('limit', String(getTimelinePageSize()));
  if (pageCursor) params.set('cursor', pageCursor);
  if (mode === 'following') params.set('following', 'true');
  return `/api/${mode === 'foryou' ? 'posts/recommended' : 'posts'}?${params.toString()}`;
}

async function fetchForYouBatch(pageCursor?: string): Promise<{ queue: Post[]; nextCursor?: string } | null> {
  if (!forYouProfile) return null;
  const params = new URLSearchParams({
    limit: String(getForYouBatchSize()),
    client_rank: '1',
    include_vectors: '1',
  });
  if (pageCursor) params.set('cursor', pageCursor);
  const response = await fetch(`/api/posts/recommended?${params.toString()}`, saveDataFetchInit());
  if (!response.ok) return null;
  const data = (await response.json()) as {
    posts?: Post[];
    next_cursor?: string;
    vectors?: Record<string, EncodedVector>;
    vector_meta?: { dim?: number };
    base_scores?: Record<string, number>;
  };
  const posts = (data.posts ?? []).filter((post) => !seenIds.has(post.id));
  if (posts.length === 0) return { queue: [], nextCursor: data.next_cursor || undefined };
  const dim = data.vector_meta?.dim ?? RECOMMENDATION_VECTOR_DIM;
  const vectors = new Map<string, number[]>();
  for (const [postId, encoded] of Object.entries(data.vectors ?? {})) {
    const vector = decodeVector(encoded, dim);
    if (vector) vectors.set(postId, vector);
  }
  const queue = rankCandidates({
    items: posts,
    profile: forYouProfile.vector,
    getVector: (post) => vectors.get(post.id) ?? null,
    getBaseScore: (post) => data.base_scores?.[post.id] ?? 0,
    getAuthor: (post) => post.actor_id ?? post.user_id,
    limit: posts.length,
  });
  return { queue, nextCursor: data.next_cursor || undefined };
}

function takePage(limit: number): Post[] {
  const page: Post[] = [];
  while (page.length < limit && forYouQueue.length > 0) {
    const post = forYouQueue.shift();
    if (!post || seenIds.has(post.id)) continue;
    seenIds.add(post.id);
    page.push(post);
  }
  return page;
}

async function loadInitial(): Promise<void> {
  if (destroyed || loading) return;
  const gen = ++generation;
  loading = true;
  errorMessage = '';
  try {
    if (mode === 'foryou' && currentUser) {
      const profile = await getRecommendationProfile();
      if (destroyed || gen !== generation) return;
      if (profile) {
        const batch = await fetchForYouBatch();
        if (destroyed || gen !== generation) return;
        if (batch && (batch.queue.length > 0 || batch.nextCursor)) {
          forYouProfile = profile;
          forYouQueue = batch.queue;
          const first = takePage(getTimelinePageSize());
          items = injectAds(first, ads, everyN);
          cursor = batch.nextCursor;
          hasMore = forYouQueue.length > 0 || Boolean(batch.nextCursor);
          root?.dispatchEvent(new CustomEvent('timelineReady'));
          return;
        }
      }
    }
    const response = await fetch(buildApiUrl(), saveDataFetchInit());
    if (!response.ok) throw new Error('Failed to fetch posts');
    const data = (await response.json()) as { posts?: Post[]; next_cursor?: string };
    if (destroyed || gen !== generation) return;
    const posts = (data.posts ?? []).filter((post) => !seenIds.has(post.id));
    for (const post of posts) seenIds.add(post.id);
    items = injectAds(posts, ads, everyN);
    cursor = data.next_cursor;
    hasMore = Boolean(data.next_cursor) || posts.length >= getTimelinePageSize();
    root?.dispatchEvent(new CustomEvent('timelineReady'));
  } catch {
    if (!destroyed && gen === generation) errorMessage = t('timeline.load_failed');
  } finally {
    if (!destroyed && gen === generation) {
      loading = false;
      loadedOnce = true;
    }
  }
}

async function loadMore(): Promise<void> {
  if (loading || !hasMore || destroyed) return;
  const gen = generation;
  loading = true;
  try {
    let page: Post[] = [];
    if (mode === 'foryou' && currentUser && forYouProfile) {
      page = takePage(getTimelinePageSize());
      while (page.length === 0 && cursor) {
        const previousCursor = cursor;
        const batch = await fetchForYouBatch(cursor);
        if (destroyed || gen !== generation) return;
        if (!batch) break;
        forYouQueue = batch.queue;
        cursor = batch.nextCursor;
        page = takePage(getTimelinePageSize());
        if (batch.queue.length === 0 && (!batch.nextCursor || batch.nextCursor === previousCursor)) {
          cursor = undefined;
          break;
        }
      }
    } else if (cursor) {
      const response = await fetch(buildApiUrl(cursor), saveDataFetchInit());
      if (!response.ok) throw new Error('Failed to fetch posts');
      const data = (await response.json()) as { posts?: Post[]; next_cursor?: string };
      page = (data.posts ?? []).filter((post) => !seenIds.has(post.id));
      for (const post of page) seenIds.add(post.id);
      cursor = data.next_cursor;
    }
    if (page.length > 0) items = [...items, ...injectAds(page, ads, everyN)];
    hasMore = Boolean(cursor) || (mode === 'foryou' && forYouQueue.length > 0);
  } catch {
    // keep the existing feed on a failed page load
  } finally {
    if (!destroyed) loading = false;
  }
}

async function loadAdConfig(): Promise<void> {
  try {
    // The spacing config is an authenticated admin endpoint; guests would only
    // get a 404, so skip it for them (matches the legacy timeline).
    const fetches: Array<Promise<Response>> = [fetch('/api/ads/active')];
    if (currentUser) fetches.push(fetch('/api/admin/ads/config'));
    const [adsRes, configRes] = await Promise.all(fetches);
    if (destroyed) return;
    if (adsRes.ok) {
      const data = (await adsRes.json()) as { ads?: Ad[] };
      ads = Array.isArray(data.ads) ? data.ads : [];
    }
    if (configRes?.ok) {
      const data = (await configRes.json()) as { every_n?: number };
      const base = Number(data.every_n) || 8;
      everyN = isDataSaverEnabled() ? Math.max(1, Math.round(base * DATA_SAVER_AD_SPACING_MULTIPLIER)) : base;
    }
  } catch {
    // ads are optional
  }
}

function resetAndLoad(): void {
  // An in-flight request must not repopulate the feed after a mode switch.
  generation++;
  loading = false;
  loadedOnce = false;
  errorMessage = '';
  items = [];
  seenIds.clear();
  forYouQueue = [];
  forYouProfile = null;
  cursor = undefined;
  hasMore = true;
  void loadInitial();
}

function switchMode(next: Mode): void {
  if (mode === next) return;
  mode = next;
  resetAndLoad();
}

function handleNewPost(post: Post): void {
  // The recommendation API excludes your own posts, so For You must not prepend.
  if (mode === 'foryou') return;
  items = [post, ...items];
}

function submitHashtag(): void {
  const tag = hashtag.trim().replace(/^#/, '');
  if (!tag) return;
  void navigate(`/explore?tag=${encodeURIComponent(tag)}`);
}

function onKeydown(e: KeyboardEvent): void {
  if (!e.altKey || e.defaultPrevented) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (isModalOpen()) return;
  if (e.key === '1') {
    e.preventDefault();
    switchMode('following');
  } else if (e.key === '2') {
    e.preventDefault();
    switchMode('foryou');
  } else if (e.key === '3') {
    e.preventDefault();
    switchMode('global');
  }
}

onMount(() => {
  // Ads are optional: never hold the first feed request for a full second.
  void Promise.race([loadAdConfig(), new Promise<void>((resolve) => setTimeout(resolve, 200))]).then(
    () => void loadInitial(),
  );

  boundModeShortcut = onKeydown;
  window.addEventListener('keydown', boundModeShortcut);
  const onPostCreated = ((e: Event) => handleNewPost((e as CustomEvent<Post>).detail)) as EventListener;
  window.addEventListener('postCreated', onPostCreated);
  disposePostCreated = () => window.removeEventListener('postCreated', onPostCreated);

  if (fabHost) {
    fabButton = makeFabButton(() => {
      if (!currentUser) {
        void navigate('/login');
        return;
      }
      openPostModal({ currentUser, onPostCreated: handleNewPost });
    });
    fabHost.appendChild(fabButton);
    fabButton.addEventListener('openLeftNav', () => {
      const nav = document.querySelector<HTMLElement>('.left-nav');
      if (nav) {
        import('../left-nav-drawer.ts').then(({ openLeftNav }) => openLeftNav(nav));
      }
    });
  }

  if (loadSentinel && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: '400px' },
    );
    observer.observe(loadSentinel);
  }
  updateFab();
});

onDestroy(() => {
  destroyed = true;
  generation++;
  if (boundModeShortcut) window.removeEventListener('keydown', boundModeShortcut);
  disposePostCreated?.();
  observer?.disconnect();
  fabObserver?.disconnect();
  fabButton?.remove();
});

function updateFab(): void {
  if (!fabButton || !root) return;
  const composer = root.querySelector('.post-composer');
  if (!composer || !currentUser) {
    fabButton.classList.add('visible');
    return;
  }
  fabObserver?.disconnect();
  fabObserver = new IntersectionObserver((entries) => {
    fabButton?.classList.toggle('visible', !entries[0]?.isIntersecting);
  });
  fabObserver.observe(composer);
}
</script>

<div bind:this={root} class="timeline">
  <div class="timeline-header">
    <div class="feed-toggle">
      <button class="feed-toggle-btn" class:active={mode === 'foryou'} type="button" onclick={() => switchMode('foryou')}>{t('timeline.for_you')}</button>
      <button class="feed-toggle-btn" class:active={mode === 'following'} type="button" onclick={() => switchMode('following')}>{t('timeline.following')}</button>
      <button class="feed-toggle-btn" class:active={mode === 'global'} type="button" onclick={() => switchMode('global')}>{t('timeline.global')}</button>
      <button class="feed-toggle-btn feed-reload-btn" type="button" onclick={resetAndLoad}>{t('timeline.reload')}</button>
    </div>
  </div>

  {#if currentUser}
    <Composer />
  {:else}
    <div class="timeline-promo">
      <div class="timeline-promo-title">{t('timeline.promo_title')}</div>
      <p class="timeline-promo-desc">{t('timeline.promo_desc')}</p>
      <button class="timeline-promo-arcade-btn" type="button" onclick={() => void navigate('/arcade')}>{t('timeline.promo_arcade_btn')}</button>
    </div>
  {/if}

  <div class="hashtag-input" style="display: none;">
    <input bind:this={hashtagInput} class="hashtag-input-field" bind:value={hashtag} placeholder={t('timeline.hashtag_placeholder')} onkeydown={(e) => { if (e.key === 'Enter') submitHashtag(); }} />
    <button class="hashtag-search-btn" type="button" onclick={submitHashtag}>{t('timeline.search')}</button>
  </div>

  {#if errorMessage}
    <div class="timeline-error">{errorMessage}</div>
  {/if}

  <div bind:this={postList} class="post-list">
    {#each items as item (item.id)}
      <CardHost {item} options={cardOptions} />
    {/each}
    {#if items.length === 0 && !loadedOnce}
      <div class="timeline-skeletons" aria-hidden="true">
        {#each [0, 1, 2] as slot (slot)}
          <article class="skeleton-card" aria-hidden="true">
            <div class="skeleton-header"><div class="skeleton-avatar"></div><div class="skeleton-user"><div class="skeleton-line skeleton-line--name"></div><div class="skeleton-line skeleton-line--time"></div></div></div>
            <div class="skeleton-text"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line skeleton-line--short"></div></div>
            <div class="skeleton-media"></div>
            <div class="skeleton-actions"><div class="skeleton-action"></div><div class="skeleton-action"></div><div class="skeleton-action"></div></div>
          </article>
        {/each}
      </div>
    {:else if items.length === 0}
      <div class="timeline-empty">
        <p class="timeline-empty-title">{t('timeline.empty_title')}</p>
        <p class="timeline-empty-desc">{t('timeline.empty_desc')}</p>
      </div>
    {/if}
  </div>

  <div bind:this={loadSentinel} class="load-sentinel"></div>
  <div class="load-more-container">
    <button class="load-more-btn" type="button" disabled={loading || !hasMore} onclick={() => void loadMore()}>
      {loading ? t('common.loading') : hasMore ? t('timeline.load_more') : t('timeline.no_more')}
    </button>
  </div>
</div>

<div bind:this={fabHost} class="fab-host"></div>
