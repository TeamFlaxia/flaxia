<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import type { Post } from '../../../shared/types/post.ts';
import { t } from '../i18n.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import CardHost from '../timeline/CardHost.svelte';
import type { CardOptions } from '../timeline/cards.ts';

interface Props {
  sandboxOrigin: string;
  currentUser?: {
    username: string;
    id: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
  } | null;
}

let { sandboxOrigin, currentUser = null }: Props = $props();

const PAGE_SIZE = 20;

let posts = $state<Post[]>([]);
let cursor: string | null = null;
let loading = $state(false);
// biome-ignore lint/correctness/noUnusedVariables: read by the Svelte template
let loadedOnce = $state(false);
let hasMore = $state(false);
// biome-ignore lint/correctness/noUnusedVariables: read by the Svelte template
let error = $state('');
let sentinel: HTMLDivElement;
let observer: IntersectionObserver | null = null;
let generation = 0;
let destroyed = false;
const seenIds = new Set<string>();

// biome-ignore lint/correctness/noUnusedVariables: passed to CardHost in markup
const cardOptions = $derived<CardOptions>({
  sandboxOrigin,
  currentUser,
  onDelete: (postId: string) => {
    posts = posts.filter((post) => post.id !== postId);
  },
});

function apiUrl(pageCursor?: string): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (pageCursor) params.set('cursor', pageCursor);
  return `/api/federated/posts?${params.toString()}`;
}

async function load(pageCursor?: string): Promise<void> {
  if (loading || destroyed || (!hasMore && pageCursor)) return;
  const gen = generation;
  loading = true;
  error = '';
  try {
    const response = await fetch(apiUrl(pageCursor), { credentials: 'include' });
    if (!response.ok) throw new Error('federated load failed');
    const data = (await response.json()) as { posts?: Post[]; next_cursor?: string | null };
    if (destroyed || gen !== generation) return;
    const incoming = (data.posts ?? []).filter((post) => !seenIds.has(post.id));
    for (const post of incoming) seenIds.add(post.id);
    posts = pageCursor ? [...posts, ...incoming] : incoming;
    cursor = data.next_cursor ?? null;
    hasMore = Boolean(cursor) && incoming.length > 0;
  } catch {
    if (!destroyed && gen === generation) error = t('federated.load_failed');
  } finally {
    if (!destroyed && gen === generation) {
      loading = false;
      loadedOnce = true;
    }
  }
}

// biome-ignore lint/correctness/noUnusedVariables: wired to the retry button in markup
function reload(): void {
  generation++;
  posts = [];
  seenIds.clear();
  cursor = null;
  hasMore = false;
  loading = false;
  loadedOnce = false;
  error = '';
  void load();
}

onMount(() => {
  void load();
  if (sentinel && typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        // The server decides the order; this page never re-sorts the pool.
        if (entries[0]?.isIntersecting && hasMore && !loading) void load(cursor ?? undefined);
      },
      { rootMargin: '400px' },
    );
    observer.observe(sentinel);
  }
});

onDestroy(() => {
  destroyed = true;
  generation++;
  observer?.disconnect();
});
</script>

<div class="federated-page">
  <div class="page-header">
    <div class="page-header-titles">
      <h1 class="page-header-title fx-display">{t('federated.title')}</h1>
      <span class="page-header-subtitle">{t('federated.subtitle')}</span>
    </div>
  </div>

  <div class="federated-note" role="note">
    <span class="federated-popular-badge" aria-label={t('federated.popular_label')}>★ {t('federated.popular_label')}</span>
    <span class="federated-hide-hint">{t('federated.hide_hint')}</span>
  </div>

  {#if error}
    <div class="timeline-error" role="alert">
      {error}
      <button class="federated-retry" type="button" onclick={reload}>{t('common.retry')}</button>
    </div>
  {/if}

  <div class="post-list">
    {#each posts as post (post.id)}
      <CardHost item={post} options={cardOptions} />
    {/each}

    {#if posts.length === 0 && !loadedOnce}
      <div class="timeline-skeletons" aria-hidden="true">
        {#each [0, 1, 2] as slot (slot)}
          <article class="skeleton-card" aria-hidden="true">
            <div class="skeleton-header"><div class="skeleton-avatar"></div><div class="skeleton-user"><div class="skeleton-line skeleton-line--name"></div></div></div>
            <div class="skeleton-text"><div class="skeleton-line"></div><div class="skeleton-line skeleton-line--short"></div></div>
          </article>
        {/each}
      </div>
    {:else if posts.length === 0 && !error}
      <div class="timeline-empty">
        <p class="timeline-empty-title">{t('federated.empty')}</p>
      </div>
    {/if}
  </div>

  <div bind:this={sentinel} class="load-sentinel"></div>
  <div class="load-more-container">
    <button class="load-more-btn" type="button" disabled={loading || !hasMore} onclick={() => void load(cursor ?? undefined)}>
      {loading ? t('common.loading') : hasMore ? t('timeline.load_more') : t('timeline.no_more')}
    </button>
  </div>
</div>

<style>
  .federated-page {
    max-width: 600px;
    margin: 0 auto;
  }
  .federated-note {
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    margin: 0.75rem 0;
    padding: 0.65rem 0.85rem;
  }
  .federated-popular-badge {
    background: var(--accent-soft, rgba(22, 163, 74, 0.15));
    border-radius: 999px;
    color: var(--accent-text, var(--primary));
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    white-space: nowrap;
  }
  .federated-hide-hint {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .federated-retry {
    background: none;
    border: 0;
    color: var(--link);
    cursor: pointer;
    margin-left: 0.5rem;
    text-decoration: underline;
  }
</style>
