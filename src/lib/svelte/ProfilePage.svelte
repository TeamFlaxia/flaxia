<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { applyNameColor } from '../../../shared/name-color.ts';
import type { Post } from '../../../shared/types/post.ts';
import { linkifyHashtags, linkifyUrls, processText, renderMathElements } from '../../components/PostText.ts';
import { showSignInPrompt } from '../../components/SignInPrompt.ts';
import { attachPlusBadge } from '../avatar.ts';
import { formatCount } from '../format.ts';
import { t } from '../i18n.ts';
import { nativeApiHref } from '../native-api.ts';
import { navigate } from '../navigation.ts';
import { mountTitleBadge } from '../post/header-badge.ts';
import { mountUserPostList, type UserPostListHandle } from '../post/user-post-list.ts';
import { openPostModal } from '../post-modal.ts';
import {
  confirmBlock,
  openBlockedUsers,
  openEditProfile,
  openFollowerList,
  type ProfileModalUser,
  showLogoutConfirm,
} from '../profile/modals.ts';
import { signalSsrHandover } from '../ssr-handover.ts';
import { mountPostCard } from '../timeline/cards.ts';

interface CurrentUser {
  username: string;
  id: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
}

interface ProfileData extends ProfileModalUser {
  frozen?: boolean;
  frozen_reason?: string | null;
  created_at?: string;
  pinned_post_id?: string | null;
  posts_count?: number;
  followers_count?: number;
  following_count?: number;
  is_following?: boolean;
  is_blocked?: boolean;
}

type Tab = 'posts' | 'freshs' | 'bookmarks';

interface Props {
  username: string;
  currentUser: CurrentUser | null;
  sandboxOrigin: string;
  onOpenSettings?: () => void;
}

let { username, currentUser = null, sandboxOrigin, onOpenSettings }: Props = $props();

let root: HTMLDivElement;
let banner: HTMLDivElement;
let avatar: HTMLDivElement;
let displayName: HTMLDivElement;
let usernameEl: HTMLDivElement;
let joinedEl: HTMLDivElement;
let titleHost: HTMLSpanElement;
let pinnedHost: HTMLDivElement;
let postsHost: HTMLDivElement;
let freshsHost: HTMLDivElement;
let bookmarksHost: HTMLDivElement;
let fabHost: HTMLDivElement;
let kebabMenu: HTMLDivElement;

let data = $state<ProfileData | null>(null);
let loading = $state(true);
let notFound = $state(false);
let frozen = $state(false);
let following = $state(false);
let blocked = $state(false);
let busy = $state(false);
let activeTab = $state<Tab>('posts');
let menuOpen = $state(false);
let pinnedPost = $state<Post | null>(null);
let blockedCount = $state(0);
let bioHtml = $state('');
let bioText = $state('');
let listHandles: Partial<Record<Tab, UserPostListHandle>> = {};
let pinnedHandle: { destroy: () => void } | null = null;
let generation = 0;

const own = $derived(currentUser?.username === username);
const tabs: Array<{ key: Tab; label: string }> = [
  { key: 'posts', label: '' },
  { key: 'freshs', label: t('profile.view_likes') },
  { key: 'bookmarks', label: t('profile.view_bookmarks') },
];

function applyTitleBadge(): void {
  if (!titleHost || !data) return;
  titleHost.replaceChildren();
  mountTitleBadge(titleHost, data as never);
}

function applyAvatar(): void {
  if (!avatar || !data) return;
  if (data.avatar_key) {
    avatar.style.backgroundImage = `url(${nativeApiHref(`/api/images/${data.avatar_key}`)})`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
    avatar.textContent = '';
  } else {
    avatar.textContent = data.username.charAt(0).toUpperCase();
  }
  attachPlusBadge(avatar, (data.badge_type as never) ?? null);
}

function applyBanner(): void {
  if (!banner || !data) return;
  banner.style.backgroundImage = data.header_key ? `url(${nativeApiHref(`/api/images/${data.header_key}`)})` : '';
}

async function loadPinned(): Promise<void> {
  try {
    const res = await fetch(`/api/users/${username}/pinned`, { credentials: 'include' });
    if (!res.ok) return;
    const result = (await res.json()) as { post: Post | null };
    pinnedPost = result.post ?? null;
    queueMicrotask(mountPinned);
  } catch (error) {
    console.error('Failed to load pinned post:', error);
  }
}

function mountPinned(): void {
  pinnedHandle?.destroy();
  pinnedHandle = null;
  if (!pinnedHost) return;
  pinnedHost.replaceChildren();
  if (!pinnedPost) return;
  const host = document['createElement']('div');
  pinnedHost.replaceChildren(host);
  pinnedHandle = mountPostCard(host, pinnedPost, {
    sandboxOrigin,
    currentUser,
    onDelete: () => {},
  });
}

async function loadBlockedCount(): Promise<void> {
  try {
    const res = await fetch('/api/users/me/blocked', { credentials: 'include' });
    if (!res.ok) return;
    const result = (await res.json()) as { users?: unknown[] };
    blockedCount = result.users?.length ?? 0;
  } catch {
    /* ignore */
  }
}

async function loadUser(): Promise<void> {
  const gen = ++generation;
  loading = true;
  try {
    const response = await fetch(`/api/users/${username}`, { credentials: 'include' });
    if (!response.ok) {
      notFound = true;
      return;
    }
    const result = (await response.json()) as { user?: ProfileData };
    if (!result.user || gen !== generation) return;
    data = result.user;
    frozen = Boolean(result.user.frozen);
    if (frozen) return;

    following = result.user.is_following ?? false;
    blocked = result.user.is_blocked ?? false;
    if (own) void loadBlockedCount();
    void loadPinned();
    window.dispatchEvent(
      new CustomEvent('profilePinChanged', { detail: { pinnedId: result.user.pinned_post_id ?? null } }),
    );

    if (result.user.bio) {
      void processText(result.user.bio)
        .then((html) => {
          const holder = document['createElement']('div');
          holder.innerHTML = html;
          renderMathElements(holder);
          linkifyUrls(holder);
          linkifyHashtags(holder);
          bioHtml = holder.innerHTML;
          bioText = '';
        })
        .catch(() => {
          // Never inject the raw bio: markdown/sanitizer chunks can fail to load.
          bioHtml = '';
          bioText = result.user?.bio ?? '';
        });
    }
    queueMicrotask(() => {
      applyAvatar();
      applyBanner();
      applyTitleBadge();
      if (displayName)
        applyNameColor(displayName, (data?.name_color as never) ?? null, (data?.badge_type as never) ?? null);
    });
  } catch (error) {
    console.error('Failed to load user data:', error);
  } finally {
    if (gen === generation) loading = false;
  }
}

function mountList(tab: Tab, host: HTMLDivElement | undefined): void {
  if (!host) return;
  listHandles[tab] = mountUserPostList(host, {
    username,
    sandboxOrigin,
    currentUser,
    source: tab,
    showPinOption: own && tab === 'posts',
    onTogglePin: own && tab === 'posts' ? (id) => void togglePin(id) : undefined,
  });
  // Any interactive tab is ready to replace the SSR fallback; waiting only
  // for 'posts' left the static markup mounted on freshs/bookmarks tabs.
  signalSsrHandover();
}

function selectTab(tab: Tab): void {
  if (activeTab === tab) return;
  activeTab = tab;
  const hosts: Record<Tab, HTMLDivElement | undefined> = {
    posts: postsHost,
    freshs: freshsHost,
    bookmarks: bookmarksHost,
  };
  if (!listHandles[tab]) mountList(tab, hosts[tab]);
}

async function togglePin(postId: string): Promise<void> {
  if (!currentUser || !data) return;
  const currentlyPinned = data.pinned_post_id === postId;
  try {
    const res = currentlyPinned
      ? await fetch('/api/profile/pin', { method: 'DELETE', credentials: 'include' })
      : await fetch('/api/profile/pin', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postId }),
        });
    if (!res.ok) return;
    const next = currentlyPinned ? null : postId;
    data = { ...data, pinned_post_id: next };
    await loadPinned();
    window.dispatchEvent(new CustomEvent('profilePinChanged', { detail: { pinnedId: next } }));
  } catch (error) {
    console.error('Failed to toggle pin:', error);
  }
}

async function toggleFollow(): Promise<void> {
  if (!currentUser) {
    showSignInPrompt(
      'follow',
      () => void navigate('/login'),
      () => void navigate('/register'),
    );
    return;
  }
  if (!data || busy) return;
  busy = true;
  try {
    const res = await fetch(`/api/users/${username}/follow`, {
      method: following ? 'DELETE' : 'POST',
      credentials: 'include',
    });
    if (res.ok) {
      const result = (await res.json()) as { followers_count: number; following_count: number };
      following = !following;
      data = {
        ...data,
        followers_count: result.followers_count,
        following_count: result.following_count,
        is_following: following,
      };
    } else console.error('Failed to follow:', await res.text());
  } catch (error) {
    console.error('Follow error:', error);
  } finally {
    busy = false;
  }
}

async function toggleBlock(): Promise<void> {
  if (!currentUser) {
    showSignInPrompt(
      'block',
      () => void navigate('/login'),
      () => void navigate('/register'),
    );
    return;
  }
  if (!data || busy) return;
  if (!blocked && !(await confirmBlock(username))) return;
  busy = true;
  try {
    const res = await fetch(`/api/users/${username}/block`, {
      method: blocked ? 'DELETE' : 'POST',
      credentials: 'include',
    });
    if (res.ok) {
      blocked = !blocked;
      if (blocked) {
        following = false;
        data = { ...data, is_following: false };
      }
    } else console.error('Failed to block:', await res.text());
  } catch (error) {
    console.error('Block error:', error);
  } finally {
    busy = false;
  }
}

function editProfile(): void {
  if (data) openEditProfile(data, () => void loadUser());
}

function openPostComposer(): void {
  if (!currentUser) return;
  openPostModal({
    currentUser,
    onPostCreated: (post) => listHandles.posts?.addPost(post as Post),
  });
}

onMount(() => {
  void loadUser();
  queueMicrotask(() => mountList('posts', postsHost));
});

onDestroy(() => {
  generation++;
  pinnedHandle?.destroy();
  Object.values(listHandles).forEach((h) => {
    h?.destroy();
  });
  fabHost?.replaceChildren();
});
</script>

<div bind:this={root} class="profile-page">
  <div class="profile-topbar">
    <button class="profile-back-button" type="button" onclick={() => window.history.back()}>←</button>
    <span class="profile-topbar-title">@{username}</span>
    {#if own}
      <button class="profile-kebab-button" aria-label={t('common.menu')} onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; }}>⋯</button>
      {#if menuOpen}
        <div bind:this={kebabMenu} class="profile-kebab-menu" style="display:block;" onclick={(e) => e.stopPropagation()} role="menu" tabindex="-1">
          <button class="profile-menu-item" type="button" onclick={() => { menuOpen = false; showLogoutConfirm(username); }}>{t('profile.log_out')}</button>
        </div>
      {/if}
    {/if}
  </div>

  {#if notFound}
    <p class="profile-not-found">{t('profile.not_found')}</p>
  {:else if frozen}
    <div class="profile-banner"></div>
    <div class="profile-header"><div class="profile-avatar-section"><div bind:this={avatar} class="profile-avatar fx-display">{username.charAt(0).toUpperCase()}</div><div class="profile-info"><div bind:this={displayName} class="profile-display-name fx-display">{data?.display_name || username}</div></div></div></div>
    <p class="profile-frozen-notice">{t('profile.frozen_notice', { reason: data?.frozen_reason || '' })}</p>
  {:else}
    <div bind:this={banner} class="profile-banner" class:profile-banner--editable={own} onclick={() => { if (own) editProfile(); }} role={own ? 'button' : undefined}>
      <div class="profile-banner-overlay">{t('profile.change_header')}</div>
    </div>

    <div class="profile-header">
      <div class="profile-avatar-section">
        <div bind:this={avatar} class="profile-avatar fx-display">{username.charAt(0).toUpperCase()}</div>
        <div class="profile-info">
          <div bind:this={displayName} class="profile-display-name fx-display">{data?.display_name ?? t('profile.loading')}</div>
          <div class="profile-username">@{username}<span bind:this={titleHost} class="post-title-badge-host"></span></div>
          <div class="profile-bio">{#if bioHtml}{@html bioHtml}{:else}{bioText}{/if}</div>
          <div bind:this={joinedEl} class="profile-joined-date">{data?.created_at ? t('profile.joined', { date: new Date(data.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) }) : t('profile.joined', { date: t('common.loading') })}</div>
          {#if own}
            <div class="profile-own-actions" style="display:flex;">
              <button class="profile-button profile-button--secondary" type="button" onclick={editProfile}>{t('profile.edit')}</button>
              <button class="profile-button profile-button--secondary" type="button" onclick={() => onOpenSettings?.()}>{t('nav.settings')}</button>
            </div>
          {/if}
        </div>
      </div>
    </div>

    <div class="profile-stats">
      <div class="profile-stat"><span class="stat-number">{formatCount(data?.posts_count ?? 0)}</span> {t('profile.posts_label')}</div>
      <div class="profile-stat profile-stat--link" onclick={() => openFollowerList(username, 'followers', data)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') openFollowerList(username, 'followers', data); }}><span class="stat-number">{formatCount(data?.followers_count ?? 0)}</span> {t('profile.followers_label')}</div>
      <div class="profile-stat profile-stat--link" onclick={() => openFollowerList(username, 'following', data)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') openFollowerList(username, 'following', data); }}><span class="stat-number">{formatCount(data?.following_count ?? 0)}</span> {t('profile.following_label')}</div>
      {#if own && blockedCount > 0}
        <div class="profile-stat profile-stat--link profile-stat--quiet" onclick={() => openBlockedUsers(() => { blockedCount = Math.max(0, blockedCount - 1); })} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') openBlockedUsers(() => {}); }}><span class="stat-number">{formatCount(blockedCount)}</span> {t('profile.blocked_label')}</div>
      {/if}
    </div>

    {#if !own}
      <hr />
      <div class="profile-actions">
        <button class="profile-button" class:profile-button--secondary={following} class:profile-button--follow={!following} disabled={busy} type="button" onclick={() => void toggleFollow()}>{following ? t('profile.following') : t('profile.follow')}</button>
        <button class="profile-button" class:profile-button--danger-outline={blocked} class:profile-button--danger={!blocked} disabled={busy} type="button" onclick={() => void toggleBlock()}>{blocked ? t('profile.unblock') : t('profile.block')}</button>
      </div>
    {/if}

    {#if pinnedPost}
      <div bind:this={pinnedHost} class="profile-pinned">
        <div class="profile-pinned-label">{t('profile.pinned_label')}</div>
      </div>
    {/if}

    {#if own}
      <div class="profile-tabs">
        {#each tabs as tab (tab.key)}
          <button class="profile-tab" class:profile-tab--active={activeTab === tab.key} data-tab={tab.key} type="button" onclick={() => selectTab(tab.key)}>{tab.key === 'posts' ? t('profile.your_posts') : tab.label}</button>
        {/each}
      </div>
    {/if}

    <div class="profile-tab-content">
      {#if activeTab === 'posts'}<div class="profile-posts-tab"><div bind:this={postsHost}></div></div>{/if}
      {#if activeTab === 'freshs'}<div bind:this={freshsHost}></div>{/if}
      {#if activeTab === 'bookmarks'}<div bind:this={bookmarksHost}></div>{/if}
    </div>
  {/if}

  {#if currentUser}<div bind:this={fabHost} class="fab-host"><button class="timeline-fab visible" type="button" aria-label={t('composer.post_button')} onclick={openPostComposer}>＋</button></div>{/if}
</div>
