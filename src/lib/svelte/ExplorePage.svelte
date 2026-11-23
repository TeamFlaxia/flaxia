<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import type { Post } from '../../../shared/types/post.ts';
import { attachPlusBadge } from '../avatar.ts';
import { createFabButton as makeFabButton } from '../fab-button.ts';
import { formatCount, formatPercentage, relativeBarPercent } from '../format.ts';
import { t } from '../i18n.ts';
import { nativeApiHref } from '../native-api.ts';
import { navigate } from '../navigation.ts';
import { openPostModal } from '../post-modal.ts';
import CardHost from '../timeline/CardHost.svelte';
import type { CardOptions } from '../timeline/cards.ts';
import { appendUniqueBy, uniqueBy } from '../unique.ts';
import { type TrendingTag, loadTrendingTags } from '../tags/trending.ts';

interface ExploreUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
  bio?: string;
}
interface ArcadeGame {
  id: string;
  postId: string;
  title: string;
  username: string;
  displayName?: string;
  avatarKey?: string;
  thumbnailKey?: string;
  freshCount: number;
  replyCount: number;
  impressions: number;
  isFreshed: boolean;
}
interface Suggestion {
  type: 'tag' | 'user';
  label: string;
  count?: number;
  display?: string;
  avatar?: string;
  badge?: string | null;
}
type Filter = 'posts' | 'arcade' | 'users';

interface Props {
  tag?: string;
  sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
}
let { tag, sandboxOrigin, currentUser = null }: Props = $props();

const SEARCH_HISTORY_KEY = 'flaxia_search_history';
let filter = $state<Filter>('posts');
let searchInput = $state('');
let posts = $state<Post[]>([]);
let games = $state<ArcadeGame[]>([]);
let users = $state<ExploreUser[]>([]);
let trending = $state<TrendingTag[]>([]);
let tagCount = $state(0);
let loading = $state(false);
let hasMore = $state(true);
let error = $state('');
let suggestions = $state<Suggestion[]>([]);
let suggestionsOpen = $state(false);
let history = $state<string[]>([]);
let input: HTMLInputElement;
let sentinel: HTMLDivElement;
let fabHost: HTMLDivElement;
let fab: HTMLElement | null = null;
let cursor: string | undefined;
let generation = 0;
let destroyed = false;
let suggestController: AbortController | null = null;
let suggestTimer: ReturnType<typeof setTimeout> | null = null;

const maxTagCount = $derived(Math.max(...trending.map((t) => t.count), 1));
const cardOptions = $derived<CardOptions>({
  sandboxOrigin,
  currentUser,
  onDelete: (id) => {
    posts = posts.filter((p) => p.id !== id);
  },
});

function getHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveHistory(q: string): void {
  const next = getHistory().filter((h) => h !== q);
  next.unshift(q);
  if (next.length > 10) next.pop();
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  history = next;
}
function showHistory(): void {
  history = getHistory();
  suggestions = history.map((q) => ({ type: 'tag' as const, label: q }));
  suggestionsOpen = history.length > 0;
}

function applyPosts(incoming: Post[]): void {
  posts = appendUniqueBy(posts, incoming, (p) => p.id);
  if (!tag) {
    const last = incoming[incoming.length - 1] as Post & { score?: number };
    cursor = last?.score !== undefined ? `${last.score},${last.created_at}` : last?.created_at;
  } else {
    cursor = incoming[incoming.length - 1]?.created_at;
  }
  hasMore = incoming.length === 10;
}

async function loadContent(): Promise<void> {
  if (loading || destroyed) return;
  const gen = ++generation;
  loading = true;
  error = '';
  try {
    if (tag) {
      let url = `/api/posts?hashtag=${encodeURIComponent(tag)}&limit=10`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load tag posts');
      const data = (await res.json()) as { posts: Post[]; count?: number };
      if (data.count !== undefined) tagCount = data.count;
      if (gen !== generation) return;
      applyPosts(data.posts ?? []);
    } else if (filter === 'arcade') {
      let url = '/api/games?limit=10';
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load games');
      const data = (await res.json()) as { games: ArcadeGame[]; hasMore: boolean; cursor?: string | null };
      if (gen !== generation) return;
      games = appendUniqueBy(games, data.games ?? [], (g) => g.postId);
      cursor = data.cursor ?? undefined;
      hasMore = data.hasMore;
    } else if (filter === 'users') {
      const res = await fetch('/api/users/suggestions');
      if (!res.ok) throw new Error('Failed to load users');
      const data = (await res.json()) as { users: ExploreUser[] };
      if (gen !== generation) return;
      users = uniqueBy(data.users ?? [], (u) => u.id);
      hasMore = false;
    } else {
      const [trendingTags, postsRes] = await Promise.all([loadTrendingTags(), fetch('/api/posts/trending?limit=10')]);
      if (gen === generation) trending = trendingTags;
      if (postsRes.ok) {
        const data = (await postsRes.json()) as { posts?: Post[] };
        if (gen === generation) applyPosts(data.posts ?? []);
      }
    }
  } catch (err) {
    if (gen === generation && !destroyed) error = err instanceof Error ? err.message : 'Failed to load';
  } finally {
    if (gen === generation && !destroyed) loading = false;
  }
}

function switchFilter(next: Filter): void {
  if (filter === next) return;
  filter = next;
  posts = [];
  games = [];
  users = [];
  cursor = undefined;
  hasMore = true;
  void loadContent();
}

function performSearch(query: string): void {
  saveHistory(query);
  suggestionsOpen = false;
  void navigate(`/search?q=${encodeURIComponent(query)}&type=posts`);
}

async function fetchSuggestions(prefix: string, type: 'tag' | 'user'): Promise<void> {
  suggestController?.abort();
  const controller = new AbortController();
  suggestController = controller;
  try {
    const url =
      type === 'tag'
        ? `/api/tags/suggest?q=${encodeURIComponent(prefix)}`
        : `/api/users/suggest?q=${encodeURIComponent(prefix)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || controller !== suggestController) return;
    if (type === 'tag') {
      const data = (await res.json()) as { tags?: Array<{ tag: string; count: number }> };
      suggestions = (data.tags ?? []).map((x) => ({ type: 'tag' as const, label: x.tag, count: x.count }));
    } else {
      const data = (await res.json()) as {
        users?: Array<{ username: string; display_name: string; avatar_key: string; badge_type?: string | null }>;
      };
      suggestions = (data.users ?? []).map((u) => ({
        type: 'user' as const,
        label: u.username,
        display: u.display_name,
        avatar: u.avatar_key,
        badge: u.badge_type ?? null,
      }));
    }
    suggestionsOpen = suggestions.length > 0;
  } catch (err) {
    if ((err as { name?: string })?.name !== 'AbortError') console.error('Suggest error:', err);
  }
}

function onInput(): void {
  const val = searchInput;
  suggestController?.abort();
  if (suggestTimer) clearTimeout(suggestTimer);
  if (val.startsWith('#') || val.startsWith('@')) {
    const prefix = val.slice(1);
    if (!prefix) {
      suggestionsOpen = false;
      return;
    }
    suggestTimer = setTimeout(() => void fetchSuggestions(prefix, val[0] === '#' ? 'tag' : 'user'), 200);
    return;
  }
  if (val.length === 0) {
    showHistory();
    return;
  }
  suggestionsOpen = false;
}

function pick(s: Suggestion): void {
  suggestionsOpen = false;
  if (s.type === 'tag') void navigate(`/explore?tag=${encodeURIComponent(s.label)}`);
  else void navigate(`/profile/${encodeURIComponent(s.label)}`);
}

function onSubmit(): void {
  const q = searchInput.trim();
  suggestController?.abort();
  suggestionsOpen = false;
  if (q.startsWith('#')) {
    const after = q.slice(1).trim();
    if (after && !after.includes(' ')) {
      void navigate(`/explore?tag=${encodeURIComponent(after)}`);
      return;
    }
  }
  if (q) performSearch(q);
}

onMount(() => {
  history = getHistory();
  if (fabHost && currentUser) {
    fab = makeFabButton(() => {
      openPostModal({
        currentUser,
        onPostCreated: (post) => {
          posts = [post as Post, ...posts];
        },
      });
    }, true);
    fabHost.appendChild(fab);
  }
  if (sentinel && typeof IntersectionObserver !== 'undefined') {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) void loadContent();
      },
      { rootMargin: '400px' },
    );
    observer.observe(sentinel);
    onDestroy(() => observer.disconnect());
  }
  void loadContent();
});

onDestroy(() => {
  destroyed = true;
  generation++;
  suggestController?.abort();
  if (suggestTimer) clearTimeout(suggestTimer);
  fab?.remove();
});
</script>

<div class="explore-page">
  <div class="explore-search-section">
    <div class="search-box" style="position:relative;">
      <input bind:this={input} type="text" class="search-input" bind:value={searchInput} placeholder={t('explore.search_placeholder')} oninput={onInput} onfocus={() => { if (!searchInput) showHistory(); }} onblur={() => setTimeout(() => (suggestionsOpen = false), 200)} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } else if (e.key === 'Escape') { suggestionsOpen = false; input.blur(); } }} />
      <span class="search-icon" aria-hidden="true"></span>
      {#if suggestionsOpen}
        <div class="tag-suggest-dropdown" style="display:block;position:absolute;top:100%;left:0;right:0;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:100;max-height:300px;overflow-y:auto;margin-top:4px;">
          {#each suggestions as s (s.type + s.label)}
            <div class="suggest-item" style="padding:0.6rem 0.75rem;cursor:pointer;display:flex;align-items:center;gap:0.5rem;" onclick={() => pick(s)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') pick(s); }}>
              <span>{s.type === 'tag' ? '#' : '@'} {s.label}</span>
              {#if s.count !== undefined}<span style="margin-left:auto;color:var(--text-muted);font-size:0.75rem;">{formatCount(s.count)}</span>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <div class="explore-filter-bar">
      {#each [{ key: 'posts', label: t('explore.filter_posts') }, { key: 'arcade', label: t('explore.filter_arcade') }, { key: 'users', label: t('explore.filter_users') }] as f (f.key)}
        <button class="explore-filter-btn" class:is-active={filter === f.key} data-filter={f.key} type="button" onclick={() => switchFilter(f.key as Filter)}>{f.label}</button>
      {/each}
    </div>
  </div>

  {#if tag}
    <div class="page-header"><button class="page-header-back" type="button" onclick={() => window.history.back()}>←</button><div class="page-header-titles"><h1 class="page-header-title fx-display"># {tag}</h1><span class="page-header-subtitle">{t('explore.tag_count', { count: formatCount(tagCount) })}</span></div></div>
  {/if}

  <div class="explore-content">
    {#if !tag && filter === 'posts'}
      <div class="explore-trending-tags">
        <h2 class="explore-trending-heading">{t('explore.trending_tags')}</h2>
        {#each trending as item (item.tag)}
          <a class="trending-item" href="/explore?tag={encodeURIComponent(item.tag)}" onclick={(e) => { e.preventDefault(); void navigate(`/explore?tag=${encodeURIComponent(item.tag)}`); }}>
            <div class="trending-tag-name"># {item.tag}</div>
            <div class="trending-bar" aria-hidden="true"><span class="trending-bar-fill" style="width:{relativeBarPercent(item.count, maxTagCount)}%"></span></div>
            <div class="trending-tag-meta">{item.percentage !== undefined ? `${t('explore.trending_percent', { percentage: formatPercentage(item.percentage) })} · ` : ''}{t('right_panel.trending_count', { count: item.count })}</div>
          </a>
        {/each}
      </div>
    {/if}

    {#if !tag && filter === 'arcade'}
      <div>
        {#each games as game (game.postId)}
          <div class="explore-arcade-row" onclick={() => void navigate(`/arcade/${game.postId}`, { state: { postId: game.postId } })} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') void navigate(`/arcade/${game.postId}`); }}>
            <div class="explore-arcade-thumb">
              {#if game.thumbnailKey}<img src={nativeApiHref(`/api/thumbnail/${game.postId}`)} alt="" loading="lazy" width="180" height="101" />{:else}<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2rem;">🎮</div>{/if}
            </div>
            <div class="explore-arcade-info"><div class="explore-arcade-title">{game.title}</div><div class="explore-arcade-meta"><span>@{game.username}</span><span>{formatCount(game.freshCount)} 💚</span></div></div>
          </div>
        {/each}
      </div>
    {:else if !tag && filter === 'users'}
      {#if users.length === 0}
        <div class="page-empty"><span class="page-empty-icon"></span><p class="page-empty-title fx-display">{t('explore.no_users')}</p></div>
      {:else}
        <div>
          {#each users as user (user.id)}
            <div class="explore-user-row" onclick={() => void navigate(`/profile/${user.username}`)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') void navigate(`/profile/${user.username}`); }}>
              <div class="explore-user-avatar" style={user.avatar_key ? `background-image:url('${nativeApiHref(`/api/images/${user.avatar_key}`)}')` : ''}>{!user.avatar_key ? (user.display_name?.[0]?.toUpperCase() || user.username[0].toUpperCase()) : ''}</div>
              <div><div class="explore-user-name">@{user.username}</div><div class="explore-user-display">{user.display_name || ''}</div></div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="explore-posts">
        {#each posts as post (post.id)}<CardHost item={post} options={cardOptions} />{/each}
      </div>
    {/if}
  </div>

  {#if error}<div style="text-align:center;padding:2rem;color:var(--danger);">{error}</div>{/if}
  <div bind:this={sentinel} style="height:100px;width:100%;margin-top:1rem;"></div>
  <div bind:this={fabHost}></div>
</div>
