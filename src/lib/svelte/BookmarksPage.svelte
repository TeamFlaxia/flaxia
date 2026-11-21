<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { stripPostColors } from '../../../shared/post-colors.ts';
import type { Post } from '../../../shared/types/post.ts';
import { createFabButton as makeFabButton } from '../fab-button.ts';
import { t } from '../i18n.ts';
import { isNativeApp, nativeApiHref } from '../native-api.ts';
import { navigate } from '../navigation.ts';
import { mountOfflineDownloads } from '../post/offline-downloads.ts';
import { isZipGame } from '../post/zip-game.ts';
import { openPostModal } from '../post-modal.ts';
import { createPostUpdatedHandler as postUpdateHandler } from '../post-update.ts';
import CardHost from '../timeline/CardHost.svelte';
import type { CardOptions } from '../timeline/cards.ts';
import { appendUniqueBy } from '../unique.ts';

interface Props {
  sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
}

let { sandboxOrigin, currentUser = null }: Props = $props();

let root: HTMLDivElement;
let downloadsHost: HTMLDivElement;
let fabHost: HTMLDivElement;
let sentinel: HTMLDivElement;
let posts = $state<Post[]>([]);
let cursor: string | undefined;
let loading = $state(false);
let hasMore = $state(true);
let error = $state('');
let observer: IntersectionObserver | null = null;
let downloads: { destroy: () => void } | null = null;
let fab: HTMLElement | null = null;
let generation = 0;
let destroyed = false;
let disposePostUpdates: (() => void) | null = null;

const gamePosts = $derived(
  posts.filter((p) => isZipGame(p.payload_key) || (!!p.swf_key && p.swf_key.startsWith('swf/'))),
);
const cardOptions = $derived<CardOptions>({
  sandboxOrigin,
  currentUser,
  onDelete: (id: string) => {
    posts = posts.filter((p) => p.id !== id);
  },
});

async function loadContent(): Promise<void> {
  if (loading || destroyed) return;
  const gen = ++generation;
  loading = true;
  error = '';
  try {
    let url = '/api/bookmarks?limit=10';
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error('Failed to load bookmarks');
    const data = (await response.json()) as { posts?: Post[]; nextCursor?: string };
    const incoming = data.posts ?? [];
    if (incoming.length > 0) {
      posts = appendUniqueBy(posts, incoming, (p) => p.id);
      cursor = incoming[incoming.length - 1].created_at;
      hasMore = incoming.length === 10;
    } else {
      hasMore = false;
    }
  } catch {
    if (!destroyed && gen === generation) error = t('bookmarks.error') || 'Failed to load bookmarks';
  } finally {
    if (!destroyed && gen === generation) loading = false;
  }
}

function retry(): void {
  posts = [];
  cursor = undefined;
  hasMore = true;
  void loadContent();
}

onMount(() => {
  if (isNativeApp() && downloadsHost) downloads = mountOfflineDownloads(downloadsHost);
  const handler = postUpdateHandler(new Map());
  window.addEventListener('postUpdated', handler);
  disposePostUpdates = () => window.removeEventListener('postUpdated', handler);
  if (fabHost && currentUser) {
    fab = makeFabButton(() => {
      openPostModal({ currentUser, onPostCreated: () => {} });
    }, true);
    fabHost.appendChild(fab);
  }
  if (sentinel && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) void loadContent();
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
  }
  void loadContent();
});

onDestroy(() => {
  destroyed = true;
  generation++;
  disposePostUpdates?.();
  observer?.disconnect();
  downloads?.destroy();
  fab?.remove();
});
</script>

<div bind:this={root} class="bookmarks-page">
  <div class="page-header">
    <button type="button" class="page-header-back" aria-label="Back" onclick={() => window.history.back()}>←</button>
    <div class="page-header-titles"><h1 class="page-header-title fx-display">{t('nav.bookmarks')}</h1></div>
  </div>

  {#if isNativeApp()}<div bind:this={downloadsHost}></div>{/if}

  {#if gamePosts.length > 0}
    <div class="bookmarks-arcade">
      <div class="bookmarks-section-title">{t('explore.filter_arcade')}</div>
      <div class="bookmarks-rail-wrapper">
        <div class="bookmarks-rail-fade"></div>
        <div class="bookmarks-rail">
          {#each gamePosts as post (post.id)}
            <div class="bookmark-card" onclick={() => void navigate(`/arcade/${post.id}`, { state: { postId: post.id } })} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') void navigate(`/arcade/${post.id}`); }}>
              <div class="bookmark-thumb">
                {#if post.thumbnail_key}
                  <img src={nativeApiHref(`/api/images/${post.thumbnail_key}`)} alt="" loading="lazy" width="150" height="200" />
                {:else}
                  <span class="bookmark-thumb-icon">🎮</span>
                {/if}
                <span class="bookmark-badge">GAME</span>
              </div>
              <div class="bookmark-info">
                <div class="bookmark-title">{stripPostColors(post.text || '').slice(0, 60) || '(no text)'}</div>
                <div class="bookmark-meta">@{post.username}</div>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  <div class="bookmarks-posts" style="width:100%;">
    {#each posts as post (post.id)}
      <CardHost item={post} options={cardOptions} />
    {/each}

    {#if loading && posts.length === 0}
      <div class="bookmarks-loading" style="display:block;">
        {#each [0, 1] as slot (slot)}
          <article class="skeleton-card" aria-hidden="true">
            <div class="skeleton-header"><div class="skeleton-avatar"></div><div class="skeleton-user"><div class="skeleton-line skeleton-line--name"></div><div class="skeleton-line skeleton-line--time"></div></div></div>
            <div class="skeleton-text"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line skeleton-line--short"></div></div>
            <div class="skeleton-media"></div>
          </article>
        {/each}
      </div>
    {/if}

    {#if error}
      <div class="bookmarks-error">
        <p>{error}</p>
        <button class="bookmarks-retry" type="button" onclick={retry}>{t('bookmarks.retry') || 'Retry'}</button>
      </div>
    {/if}

    {#if !loading && posts.length === 0 && !error}
      <div class="page-empty">
        <span class="page-empty-icon"></span>
        <p class="page-empty-title fx-display">{t('bookmarks.empty') || 'No bookmarks yet'}</p>
        <button class="page-empty-cta" type="button" onclick={() => void navigate('/explore')}>{t('nav.explore')}</button>
      </div>
    {/if}
  </div>

  <div bind:this={sentinel} style="height:100px;width:100%;"></div>
  <div bind:this={fabHost}></div>
</div>
