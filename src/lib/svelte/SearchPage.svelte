<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { stripPostColors } from '../../../shared/post-colors.ts';
import type { Post } from '../../../shared/types/post.ts';
import { formatCount } from '../format.ts';
import { t } from '../i18n.ts';
import { nativeApiHref } from '../native-api.ts';
import { navigate } from '../navigation.ts';
import CardHost from '../timeline/CardHost.svelte';
import type { CardOptions } from '../timeline/cards.ts';
import { showToast } from '../toast.ts';
import { uniqueBy } from '../unique.ts';

interface WebResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  published_at?: string;
}
interface SearchUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
  bio?: string;
  is_following?: boolean;
}
interface RemoteUserResult {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  actorUrl: string;
  domain: string;
}
const REMOTE_HANDLE_PATTERN = /^@?([A-Za-z0-9_]{1,30})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/;
type Filter = 'all' | 'web' | 'users' | 'posts' | 'arcade';

interface Props {
  query: string;
  type?: 'posts' | 'users' | 'arcade' | 'web';
  currentUser: Record<string, unknown> | null;
  sandboxOrigin: string;
}

let { query, type = 'posts', currentUser = null, sandboxOrigin }: Props = $props();

let input = $state(query);
let filter = $state<Filter>(type === 'users' ? 'users' : type === 'arcade' ? 'arcade' : type === 'web' ? 'web' : 'all');
let users = $state<SearchUser[]>([]);
let posts = $state<Post[]>([]);
let arcade = $state<Post[]>([]);
let web = $state<WebResult[]>([]);
let status = $state<'loading' | 'error' | 'ready'>('loading');
let remoteUser = $state<RemoteUserResult | null>(null);
let remoteError = $state(false);
let remoteFollowPending = $state(false);
let remoteFollowing = $state(false);
let remoteFollowBusy = $state(false);
let suggestions = $state<
  Array<{
    type: 'tag' | 'user';
    label: string;
    display?: string;
    avatar?: string;
    badge?: string | null;
    count?: number;
  }>
>([]);
let suggestionsOpen = $state(false);
let searchInput: HTMLInputElement;
let arcadeScroll: HTMLDivElement;
let requestId = 0;
let suggestController: AbortController | null = null;
let suggestTimer: ReturnType<typeof setTimeout> | null = null;
let destroyed = false;

const filters: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: t('search.filter_all') },
  { key: 'web', label: t('search.filter_web') },
  { key: 'posts', label: t('explore.filter_posts') },
  { key: 'users', label: t('explore.filter_users') },
  { key: 'arcade', label: t('explore.filter_arcade') },
];
const cardOptions = $derived<CardOptions>({
  sandboxOrigin,
  currentUser,
  onDelete: (id: string) => {
    posts = posts.filter((p) => p.id !== id);
  },
});
const showUsers = $derived((filter === 'all' || filter === 'users') && users.length > 0);
const showArcade = $derived((filter === 'all' || filter === 'arcade') && arcade.length > 0);
const showPosts = $derived((filter === 'all' || filter === 'posts') && posts.length > 0);
const showWeb = $derived((filter === 'all' || filter === 'web') && web.length > 0);
const anyVisible = $derived(Boolean(remoteUser) || showUsers || showArcade || showPosts || showWeb);

function safeAvatarUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

async function lookupRemoteHandle(q: string, id: number): Promise<void> {
  remoteUser = null;
  remoteError = false;
  remoteFollowing = false;
  remoteFollowPending = false;
  try {
    const response = await fetch(`/api/remote/lookup?q=${encodeURIComponent(q)}`);
    if (id !== requestId || destroyed) return;
    if (!response.ok) {
      remoteError = true;
      return;
    }
    remoteUser = (await response.json()) as RemoteUserResult;
  } catch {
    if (id === requestId && !destroyed) remoteError = true;
  }
}

async function toggleRemoteFollow(): Promise<void> {
  if (!remoteUser || remoteFollowBusy) return;
  if (!currentUser) {
    void navigate('/login');
    return;
  }
  remoteFollowBusy = true;
  const wasFollowing = remoteFollowing;
  remoteFollowing = !wasFollowing;
  try {
    const response = await fetch('/api/remote-follow', {
      method: wasFollowing ? 'DELETE' : 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: remoteUser.handle.replace(/^@/, '') }),
    });
    if (!response.ok) throw new Error('follow failed');
    // The follow state is SSR-loaded through the short-lived client cache;
    // invalidate it so returning to the profile never shows a stale state.
    window.dispatchEvent(new CustomEvent('followChanged'));
    if (!wasFollowing) {
      const body = (await response.json().catch(() => ({}))) as { status?: string };
      remoteFollowPending = body.status === 'pending';
    } else {
      remoteFollowPending = false;
    }
  } catch {
    remoteFollowing = wasFollowing;
    showToast(t('search.remote_follow_error'), true);
  } finally {
    remoteFollowBusy = false;
  }
}

function goRemoteUser(remote: RemoteUserResult): void {
  const handle = remote.handle.replace(/^@/, '');
  const at = handle.indexOf('@');
  if (at <= 0) return;
  void navigate(`/@${encodeURIComponent(handle.slice(at + 1))}/${encodeURIComponent(handle.slice(0, at))}`);
}

async function loadResults(): Promise<void> {
  const id = ++requestId;
  status = 'loading';
  users = [];
  posts = [];
  arcade = [];
  web = [];
  remoteUser = null;
  remoteError = false;
  const remoteQuery = query.trim();
  if (REMOTE_HANDLE_PATTERN.test(remoteQuery)) {
    status = 'ready';
    await lookupRemoteHandle(remoteQuery, id);
    return;
  }
  try {
    const tab = filter === 'arcade' ? 'games' : filter;
    const response = await fetch(`/api/search/v2?q=${encodeURIComponent(query)}&tab=${tab}&limit=20`);
    if (!response.ok) throw new Error(`Search failed ${response.status}`);
    const data = (await response.json()) as {
      posts?: Post[];
      users?: SearchUser[];
      games?: Post[];
      web?: WebResult[];
    };
    if (id !== requestId || destroyed) return;
    users = uniqueBy(data.users ?? [], (u) => u.id);
    posts = uniqueBy(data.posts ?? [], (p) => p.id);
    arcade = uniqueBy(data.games ?? [], (p) => p.id);
    web = uniqueBy(data.web ?? [], (r) => r.url);
    status = 'ready';
  } catch {
    if (id === requestId && !destroyed) status = 'error';
  }
}

function setFilter(next: Filter): void {
  if (filter === next) return;
  filter = next;
  const nextType = next === 'all' ? 'posts' : next;
  void navigate(`/search?q=${encodeURIComponent(query)}&type=${nextType}`, { replaceState: true });
  void loadResults();
}

function submit(): void {
  const q = input.trim();
  suggestController?.abort();
  suggestionsOpen = false;
  if (q.startsWith('#')) {
    const after = q.slice(1).trim();
    if (after && !after.includes(' ')) {
      void navigate(`/explore?tag=${encodeURIComponent(after)}`);
      return;
    }
  }
  if (q && q !== query) {
    const nextType = filter === 'all' ? 'posts' : filter;
    void navigate(`/search?q=${encodeURIComponent(q)}&type=${nextType}`);
  }
}

async function fetchSuggestions(prefix: string, kind: 'tag' | 'user'): Promise<void> {
  suggestController?.abort();
  const controller = new AbortController();
  suggestController = controller;
  try {
    const url =
      kind === 'tag'
        ? `/api/tags/suggest?q=${encodeURIComponent(prefix)}`
        : `/api/users/suggest?q=${encodeURIComponent(prefix)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || controller !== suggestController) return;
    if (kind === 'tag') {
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
  const val = input;
  suggestController?.abort();
  if (suggestTimer) clearTimeout(suggestTimer);
  if (val.length < 2 || val.includes(' ')) {
    suggestionsOpen = false;
    return;
  }
  if (val.startsWith('#')) {
    const prefix = val.slice(1);
    if (!prefix) {
      suggestionsOpen = false;
      return;
    }
    suggestTimer = setTimeout(() => void fetchSuggestions(prefix, 'tag'), 200);
    return;
  }
  if (val.startsWith('@')) {
    const prefix = val.slice(1);
    if (!prefix) {
      suggestionsOpen = false;
      return;
    }
    suggestTimer = setTimeout(() => void fetchSuggestions(prefix, 'user'), 200);
    return;
  }
  suggestionsOpen = false;
}

function pickSuggestion(item: (typeof suggestions)[number]): void {
  suggestionsOpen = false;
  if (item.type === 'tag') void navigate(`/explore?tag=${encodeURIComponent(item.label)}`);
  else void navigate(`/profile/${encodeURIComponent(item.label)}`);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
  } else if (e.key === 'Escape') {
    suggestionsOpen = false;
    searchInput.blur();
  }
}

function goArcade(postId: string): void {
  void navigate(`/arcade/${postId}`, { state: { postId } });
}

function goProfile(user: SearchUser): void {
  void navigate(`/profile/${user.username}`, { state: { username: user.username } });
}

function onWheel(e: WheelEvent): void {
  if (!arcadeScroll || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  e.preventDefault();
  arcadeScroll.scrollLeft += e.deltaY;
}

onMount(() => void loadResults());
onDestroy(() => {
  destroyed = true;
  requestId++;
  suggestController?.abort();
  if (suggestTimer) clearTimeout(suggestTimer);
});
</script>

<div class="search-page">
  <div class="search-page-header">
    <button class="search-page-back" type="button" onclick={() => void navigate('/explore')}>←</button>
    <div class="search-box" style="position: relative;">
      <input
        bind:this={searchInput}
        type="text"
        class="search-input"
        bind:value={input}
        placeholder={t('explore.search_placeholder')}
        oninput={onInput}
        onkeydown={onKeydown}
        onblur={() => setTimeout(() => (suggestionsOpen = false), 200)}
      />
      <span class="search-icon" aria-hidden="true"></span>
      {#if suggestionsOpen}
        <div class="tag-suggest-dropdown" style="display:block;position:absolute;top:100%;left:0;right:0;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:100;max-height:300px;overflow-y:auto;margin-top:4px;">
          {#each suggestions as item (item.type + item.label)}
            <div class="suggest-item" style="padding:0.6rem 0.75rem;cursor:pointer;display:flex;align-items:center;gap:0.5rem;" onmousedown={(e) => e.preventDefault()} onclick={() => pickSuggestion(item)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') pickSuggestion(item); }}>
              {#if item.type === 'tag'}
                <span style="font-weight:600;color:var(--accent-text);font-size:0.875rem;"># {item.label}</span>
                <span style="margin-left:auto;color:var(--text-muted);font-size:0.75rem;">{formatCount(item.count ?? 0)}</span>
              {:else}
                <span class="search-avatar" style="width:28px;height:28px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:0.7rem;flex-shrink:0;">{(item.display || item.label)[0].toUpperCase()}</span>
                <span style="display:flex;flex-direction:column;">
                  <span style="font-weight:600;color:var(--text-primary);font-size:0.85rem;">@{item.label}</span>
                  <span style="font-size:0.75rem;color:var(--text-muted);">{item.display}</span>
                </span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="search-filter-bar">
    {#each filters as f (f.key)}
      <button type="button" class="filter-btn" class:is-active={filter === f.key} data-filter={f.key} onclick={() => setFilter(f.key)}>{f.label}</button>
    {/each}
  </div>

  <div class="search-page-content">
    {#if status === 'loading'}
      <div style="text-align:center;padding:3rem;color:var(--text-muted);">{t('common.loading')}</div>
    {:else if status === 'error'}
      <div style="text-align:center;padding:3rem;color:var(--danger);">{t('common.error')}</div>
    {:else}
      {#if remoteUser}
        {@const remote = remoteUser}
        <div class="search-section-label">{t('search.remote_users')}</div>
        <div
          class="search-user-row remote-user-row"
          onclick={() => goRemoteUser(remote)}
          role="button"
          tabindex="0"
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              goRemoteUser(remote);
            }
          }}
        >
          {#if safeAvatarUrl(remote.avatarUrl)}
            <img class="search-avatar" src={safeAvatarUrl(remote.avatarUrl)} alt="" style="object-fit:cover;" />
          {:else}
            <div class="search-avatar">{(remote.displayName || remote.handle)[0].toUpperCase()}</div>
          {/if}
          <div class="search-user-info">
            <div class="search-user-name">{remote.handle}</div>
            <div class="search-user-display">{remote.displayName || ''}</div>
          </div>
          {#if currentUser}
            <button
              class="remote-follow-button"
              type="button"
              aria-busy={remoteFollowBusy}
              onclick={(e) => { e.stopPropagation(); void toggleRemoteFollow(); }}
            >{remoteFollowPending ? t('search.remote_follow_pending') : remoteFollowing ? t('search.remote_following') : t('search.remote_follow')}</button>
          {/if}
        </div>
      {:else if remoteError}
        <div style="text-align:center;padding:2rem;color:var(--danger);">{t('search.remote_lookup_failed')}</div>
      {/if}
      {#if showUsers}
        {#if filter === 'all'}<div class="search-section-label">{t('search.users')}</div>{/if}
        <div>
          {#each users as user (user.id)}
            <div class="search-user-row" onclick={() => goProfile(user)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') goProfile(user); }}>
              <div
                class="search-avatar"
                style={user.avatar_key ? `background-image:url('${nativeApiHref(`/api/images/${user.avatar_key}`)}')` : ''}
              >{!user.avatar_key ? (user.display_name?.[0]?.toUpperCase() || user.username[0].toUpperCase()) : ''}</div>
              <div class="search-user-info">
                <div class="search-user-name">@{user.username}</div>
                <div class="search-user-display" data-name-color={user.name_color ?? ''}>{user.display_name || ''}</div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if showArcade}
        <div class="search-section-label">{t('explore.filter_arcade')}</div>
        {#if filter === 'all'}
          <div style="position:relative;">
            <div class="arcade-fade"></div>
            <div class="arcade-scroll" bind:this={arcadeScroll} onwheel={onWheel}>
              {#each arcade as post (post.id)}
                <div class="arcade-card" onclick={() => goArcade(post.id)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') goArcade(post.id); }}>
                  <div class="arcade-card-thumb">
                    {#if post.thumbnail_key}
                      <img src={nativeApiHref(`/api/images/${post.thumbnail_key}`)} alt="" loading="lazy" width="150" height="200" />
                    {:else}
                      <span>🎮</span>
                    {/if}
                    <span class="arcade-badge">GAME</span>
                  </div>
                  <div class="arcade-card-info">
                    <div>{stripPostColors(post.text || '').slice(0, 60) || '(no text)'}</div>
                    <div class="arcade-card-meta">@{post.username}</div>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {:else}
          {#each arcade as post (post.id)}
            <div class="arcade-row" onclick={() => goArcade(post.id)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') goArcade(post.id); }}>
              <div class="arcade-row-thumb">
                {#if post.thumbnail_key}<img src={nativeApiHref(`/api/images/${post.thumbnail_key}`)} alt="" loading="lazy" />{:else}<span>🎮</span>{/if}
                <span class="arcade-badge">GAME</span>
              </div>
              <div><div class="arcade-row-title">{stripPostColors(post.text || '') || '(no title)'}</div><div class="arcade-card-meta">@{post.username}</div></div>
            </div>
          {/each}
        {/if}
      {/if}

      {#if showPosts}
        {#if filter === 'all'}<div class="search-section-label">{t('search.posts')}</div>{/if}
        <div>
          {#each posts as post (post.id)}
            <CardHost item={post} options={cardOptions} />
          {/each}
        </div>
      {/if}

      {#if showWeb}
        <div class="search-section-label">{t('search.web_results')}</div>
        <div>
          {#each web as result (result.url)}
            {@const href = (() => { try { const u = new URL(result.url); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null; } catch { return null; } })()}
            {#if href}
              <a class="web-result" href={href} target="_blank" rel="noopener noreferrer">
                <div class="web-result-title">{result.title}</div>
                <div class="web-result-meta">{[result.source, (() => { try { return new URL(href).hostname; } catch { return ''; } })()].filter(Boolean).join(' · ')}</div>
                {#if result.snippet}<div class="web-result-snippet">{result.snippet}</div>{/if}
              </a>
            {/if}
          {/each}
        </div>
      {/if}

      {#if !anyVisible}
        <div class="page-empty"><span class="page-empty-icon"></span><p class="page-empty-title fx-display">{t('search.no_results', { query })}</p></div>
      {/if}
    {/if}
  </div>
</div>
