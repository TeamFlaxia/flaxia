<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onMount } from 'svelte';
import type { Post } from '../../../../shared/types/post.ts';
import type { Game } from '../../../types/game.js';
import { openArcadeUpload, promptArcadeSignIn, toggleArcadeBookmark, toggleArcadeFresh } from '../../arcade/actions.ts';
import { ArcadeEventTracker } from '../../arcade/events.ts';
import { ArcadeGameFeed } from '../../arcade/feed.ts';
import { isDocumentFullscreen, toggleElementFullscreen } from '../../arcade/fullscreen.ts';
import { ArcadeDragGesture } from '../../arcade/gestures.ts';
import type { ArcadeViewportApi } from '../../arcade/player.ts';
import { addPreconnects } from '../../arcade/preconnect.ts';
import { shareArcadeGame, shareArcadeScore } from '../../arcade/share.ts';
import { loadLegacyGameStorage } from '../../game-storage-broker.ts';
import { t } from '../../i18n.ts';
import { navigate } from '../../navigation.ts';
import { showToast } from '../../toast.ts';
import { markRecommendationProfileDirty } from '../../vault/recommendation-profile.ts';
import ArcadeHeader from './ArcadeHeader.svelte';
import ArcadeModals from './ArcadeModals.svelte';
import ArcadeStage from './ArcadeStage.svelte';

interface Props {
  sandboxOrigin: string;
  currentUser?: {
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
  initialGameId?: string;
  onBack?: () => void;
}

let { sandboxOrigin, currentUser = null, initialGameId, onBack }: Props = $props();

const TUTORIAL_SEEN_KEY = 'flaxia_tutorial_seen';

let viewportEl: HTMLDivElement | undefined = $state();
let games = $state<Game[]>([]);
let index = $state(0);
let activeIndex = $state<number | null>(null);
let hasMore = $state(false);
let loading = $state(true);
let gameLoading = $state(false);
let loadingType = $state<'zip' | 'html5'>('zip');
let empty = $state(false);
let storageSnapshot = $state<Promise<Record<string, string>> | undefined>(undefined);

let dragY = $state(0);
let dragging = $state(false);
let sliding = $state(false);
let transitioning = $state(false);
let fullscreen = $state(false);
let fakeFullscreen = $state(false);
let commentOpen = $state(false);
let reportOpen = $state(false);
let tutorialOpen = $state(false);

let feed: ArcadeGameFeed | null = null;
let tracker: ArcadeEventTracker | null = null;
let gesture: ArcadeDragGesture | null = null;
let viewportApi: ArcadeViewportApi | null = null;
let bookmarkBusy = false;
let renderGeneration = 0;
let renderAbort: AbortController | null = null;
let swipeVelocity = 0;
let mounted = false;

const game = $derived(activeIndex !== null ? games[activeIndex] : undefined);
const viewportOpacity = $derived(dragging ? Math.max(0.3, 1 - Math.abs(dragY) / 500) : sliding ? 0 : 1);

function isLeftNavOpen(): boolean {
  return document.querySelector('.left-nav')?.classList.contains('left-nav--open') ?? false;
}

function canSwipe(): boolean {
  return !commentOpen && !tutorialOpen && !fullscreen && !transitioning && !gameLoading && !loading && !isLeftNavOpen();
}

function syncFeed(): void {
  if (!feed) return;
  games = [...feed.games];
  index = feed.index;
  hasMore = feed.hasMore;
  empty = games.length === 0 && !loading && !gameLoading;
}

function updateGame(next: Game): void {
  feed?.replaceGame(next);
  syncFeed();
}

async function start(): Promise<void> {
  if (!feed) return;
  loading = true;
  const ok = await feed.loadInitial();
  syncFeed();
  loading = false;
  if (!ok) {
    empty = true;
    return;
  }
  await showIndex(feed.index);
}

async function showIndex(target: number): Promise<void> {
  if (!feed) return;
  const generation = ++renderGeneration;
  renderAbort?.abort();
  const controller = new AbortController();
  renderAbort = controller;

  commentOpen = false;
  reportOpen = false;
  const candidate = feed.games[target];
  loadingType = candidate?.type ?? 'zip';
  gameLoading = true;
  activeIndex = null;
  empty = false;
  const snapshot =
    candidate?.type === 'zip' && candidate.payloadKey
      ? loadLegacyGameStorage(sandboxOrigin, candidate.postId).catch((error: unknown) => {
          console.warn('Legacy game storage is unavailable:', error);
          return {} as Record<string, string>;
        })
      : undefined;

  try {
    const selection = await feed.select(target, controller.signal);
    if (generation !== renderGeneration || !mounted) return;
    gameLoading = false;
    if (!selection) {
      index = 0;
      activeIndex = null;
      empty = true;
      return;
    }
    syncFeed();
    storageSnapshot = candidate && selection.game.postId === candidate.postId ? snapshot : undefined;
    activeIndex = feed.index;
    tracker?.markEntry(fullscreen);
    feed.prefetchAhead();
  } catch (error) {
    if (generation !== renderGeneration || controller.signal.aborted) return;
    console.error('Failed to select an Arcade game:', error);
    gameLoading = false;
    empty = true;
  }
}

function recordView(): void {
  if (!game || activeIndex === null) return;
  tracker?.recordView(game, index, swipeVelocity);
  swipeVelocity = 0;
}

function nudge(direction: 1 | -1): void {
  if (transitioning) return;
  sliding = true;
  dragY = direction === 1 ? -20 : 20;
  window.setTimeout(() => {
    dragY = 0;
  }, 200);
  window.setTimeout(() => {
    sliding = false;
  }, 500);
}

async function step(direction: 1 | -1, animated = true): Promise<void> {
  if (!feed || transitioning || loading || gameLoading) return;
  const target = index + direction;
  if (target < 0) {
    nudge(direction);
    return;
  }
  if (target >= games.length) {
    if (!hasMore) {
      nudge(direction);
      return;
    }
    await feed.loadMore();
    syncFeed();
    if (target >= games.length) {
      nudge(direction);
      return;
    }
  }

  recordView();
  if (!animated) {
    await showIndex(target);
    return;
  }

  transitioning = true;
  sliding = true;
  dragY = direction === 1 ? -window.innerHeight : window.innerHeight;
  await new Promise((resolve) => setTimeout(resolve, 280));
  await showIndex(target);
  dragY = 0;
  sliding = false;
  transitioning = false;
  if (index >= games.length - 5 && hasMore) {
    void feed.loadMore().then(() => syncFeed());
  }
}

async function handleFresh(): Promise<void> {
  const current = game;
  if (!current) return;
  if (!currentUser) {
    promptArcadeSignIn('fresh');
    return;
  }
  const original = { ...current };
  const wasFreshed = Boolean(original.isFreshed);
  tracker?.push(current, 'fresh', index, swipeVelocity);
  updateGame({
    ...original,
    isFreshed: !wasFreshed,
    freshCount: Math.max(0, (original.freshCount ?? 0) + (wasFreshed ? -1 : 1)),
  });
  try {
    const data = await toggleArcadeFresh(original.postId);
    updateGame({ ...original, isFreshed: data.freshed, freshCount: data.fresh_count });
    markRecommendationProfileDirty();
  } catch {
    updateGame(original);
  }
}

async function handleBookmark(): Promise<void> {
  const current = game;
  if (!current || bookmarkBusy) return;
  if (!currentUser) {
    promptArcadeSignIn('bookmark');
    return;
  }
  const original = { ...current };
  const wasBookmarked = Boolean(original.isBookmarked);
  bookmarkBusy = true;
  updateGame({
    ...original,
    isBookmarked: !wasBookmarked,
    bookmarkCount: Math.max(0, (original.bookmarkCount ?? 0) + (wasBookmarked ? -1 : 1)),
  });
  try {
    const data = await toggleArcadeBookmark(original.postId);
    updateGame({ ...original, isBookmarked: data.bookmarked, bookmarkCount: data.bookmark_count });
    markRecommendationProfileDirty();
    showToast(data.bookmarked ? t('arcade.bookmarked') : t('arcade.bookmark_removed'));
  } catch {
    updateGame(original);
    showToast(t('arcade.bookmark_failed'), true);
  } finally {
    bookmarkBusy = false;
  }
}

function handleReport(): void {
  if (!game) return;
  if (!currentUser) {
    promptArcadeSignIn('report');
    return;
  }
  reportOpen = true;
}

function handleUpload(): void {
  if (!currentUser) {
    promptArcadeSignIn('upload');
    return;
  }
  openArcadeUpload(currentUser, (postId) => void navigate(`/arcade/${postId}`, { state: { postId } }));
}

function handleComments(): void {
  if (!game) return;
  commentOpen = !commentOpen;
}

function handleReplyCount(count: number): void {
  const current = game;
  if (!current) return;
  updateGame({ ...current, replyCount: count });
}

function handleReplyCreated(_reply: Post): void {
  if (!game) return;
  tracker?.push(game, 'reply', index, swipeVelocity);
}

function handlePostScore(score: number, label: string): void {
  const current = game;
  if (current) void shareArcadeScore(current, score, label, viewportApi?.capture ?? null);
}

function handleShare(): void {
  const current = game;
  if (!current) return;
  tracker?.push(current, 'share', index, swipeVelocity);
  void shareArcadeGame(current, viewportApi?.capture ?? null);
}

function pushFullscreenEvent(): void {
  if (game) tracker?.push(game, 'fullscreen', index, swipeVelocity);
}

function enterFakeFullscreen(): void {
  fakeFullscreen = true;
  fullscreen = true;
  pushFullscreenEvent();
  viewportApi?.focus();
}

async function handleFullscreen(): Promise<void> {
  if (!viewportEl) return;
  const action = await toggleElementFullscreen(viewportEl, fullscreen);
  if (action === 'fake') enterFakeFullscreen();
  else if (action === 'exited') {
    fakeFullscreen = false;
    fullscreen = false;
  }
  viewportApi?.focus();
}

function handleFullscreenChange(): void {
  const active = isDocumentFullscreen();
  if (active === fullscreen) return;
  if (fakeFullscreen) return;
  fullscreen = active;
  if (active) pushFullscreenEvent();
  viewportApi?.focus();
}

function onKeyDown(event: KeyboardEvent): void {
  if (tutorialOpen || fullscreen) return;
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    void step(-1);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    void step(1);
  }
}

function handleRefs(_container: HTMLDivElement, viewport: HTMLDivElement | undefined): void {
  viewportEl = viewport;
}

function handleViewportApi(api: ArcadeViewportApi | null): void {
  viewportApi = api;
}

function openTutorial(): void {
  tutorialOpen = true;
}

function closeTutorial(): void {
  tutorialOpen = false;
  try {
    localStorage.setItem(TUTORIAL_SEEN_KEY, '1');
  } catch {
    // Private mode can reject storage; the tour just reappears next time.
  }
}

$effect(() => {
  const root = document.documentElement;
  root.classList.toggle('arcade-immersive', fakeFullscreen);
  return () => root.classList.remove('arcade-immersive');
});

onMount(() => {
  mounted = true;
  tracker = new ArcadeEventTracker();
  feed = new ArcadeGameFeed({
    currentUser: currentUser ? { id: currentUser.id } : null,
    initialGameId,
    sandboxOrigin,
  });
  gesture = new ArcadeDragGesture({
    canStart: canSwipe,
    getOffset: () => dragY,
    onStart: () => {
      dragging = true;
    },
    onMove: (offset) => {
      dragY = offset;
    },
    onEnd: (direction, velocity) => {
      dragging = false;
      swipeVelocity = velocity;
      if (direction === 'reset') {
        dragY = 0;
        return;
      }
      void step(direction === 'next' ? 1 : -1);
    },
  });
  gesture.attach();

  const links = addPreconnects(['https://unpkg.com', sandboxOrigin]);

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

  if (!localStorage.getItem(TUTORIAL_SEEN_KEY)) tutorialOpen = true;
  void start();

  return () => {
    mounted = false;
    renderGeneration += 1;
    renderAbort?.abort();
    feed?.destroy();
    feed = null;
    tracker?.destroy();
    tracker = null;
    gesture?.detach();
    gesture = null;
    links();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
  };
});
</script>

<div class="arcade-page">
  {#if !fullscreen}
    <ArcadeHeader onBack={onBack} onUpload={handleUpload} onTutorial={openTutorial} />
  {/if}

  <ArcadeStage
    {game}
    {sandboxOrigin}
    {fullscreen}
    {loading}
    {gameLoading}
    {loadingType}
    {empty}
    {dragY}
    {dragging}
    {viewportOpacity}
    {storageSnapshot}
    wheelEnabled={!commentOpen && !tutorialOpen && !fullscreen && !transitioning && !gameLoading && !loading}
    onNavigate={(direction) => void step(direction)}
    onRefs={handleRefs}
    onFresh={handleFresh}
    onFullscreen={handleFullscreen}
    onShare={handleShare}
    onComments={handleComments}
    onBookmark={handleBookmark}
    onReport={handleReport}
    onPostScore={handlePostScore}
    onApi={handleViewportApi}
  />
</div>

<ArcadeModals
  {game}
  {sandboxOrigin}
  {currentUser}
  {commentOpen}
  {reportOpen}
  {tutorialOpen}
  onCloseComments={() => (commentOpen = false)}
  onCloseReport={() => (reportOpen = false)}
  onCloseTutorial={closeTutorial}
  onReplyCount={handleReplyCount}
  onReplyCreated={handleReplyCreated}
/>

<style>
  .arcade-page {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    flex: 1;
    overflow: hidden;
    background: var(--bg-primary);
    position: relative;
  }

  :global(html.arcade-immersive .left-nav),
  :global(html.arcade-immersive .right-panel) {
    display: none;
  }
</style>
