<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { applyNameColor } from '../../../shared/name-color.ts';
import { showSignInPrompt } from '../../components/SignInPrompt.js';
import { attachPlusBadge } from '../avatar.js';
import { t } from '../i18n.ts';
import { registerModal } from '../modal-state.js';
import { nativeApiHref } from '../native-api.ts';
import { navigate } from '../navigation.ts';

interface UserListItem {
  id: string;
  username: string;
  display_name: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
  followers_count: number;
  following_count: number;
  is_following?: boolean;
}

interface Props {
  username: string;
  initialTab?: 'followers' | 'following';
  currentUser: { username: string } | null;
  onClose: () => void;
}
let { username, initialTab = 'followers', currentUser, onClose }: Props = $props();

let tab = $state<'followers' | 'following'>(initialTab);
let users = $state<UserListItem[]>([]);
let nextCursor = $state<string | null>(null);
let hasMore = $state(false);
let loading = $state(true);
let failed = $state(false);
let busy = $state<Record<string, boolean>>({});

const tabLabel = $derived(tab === 'followers' ? t('follower_list.followers') : t('follower_list.following'));

function mountBadge(node: HTMLElement, badge: string | null | undefined): void {
  attachPlusBadge(node, badge);
}

function renderName(node: HTMLElement, user: UserListItem): void {
  applyNameColor(node, user.name_color, user.badge_type);
}

async function load(reset = true): Promise<void> {
  loading = true;
  failed = false;
  try {
    const endpoint = tab === 'followers' ? 'followers' : 'following';
    const url = `/api/users/${username}/${endpoint}${reset ? '' : `?cursor=${nextCursor}`}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to load users');
    const data = (await response.json()) as {
      users: UserListItem[];
      next_cursor: string | null;
      has_more: boolean;
    };
    users = reset ? data.users : [...users, ...data.users];
    nextCursor = data.next_cursor;
    hasMore = data.has_more;
  } catch (error) {
    console.error('Load users error:', error);
    failed = true;
  } finally {
    loading = false;
  }
}

function switchTab(next: 'followers' | 'following'): void {
  if (tab === next) return;
  tab = next;
  users = [];
  void load(true);
}

async function toggleFollow(user: UserListItem): Promise<void> {
  if (!currentUser) {
    showSignInPrompt(
      'follow',
      () => void navigate('/login'),
      () => void navigate('/register'),
    );
    return;
  }
  if (busy[user.username]) return;
  busy = { ...busy, [user.username]: true };
  try {
    const method = user.is_following ? 'DELETE' : 'POST';
    const response = await fetch(`/api/users/${user.username}/follow`, { method, credentials: 'include' });
    if (!response.ok) {
      console.error('Follow/unfollow failed:', await response.text());
      return;
    }
    const result = (await response.json()) as { followers_count: number; following_count: number };
    users = users.map((entry) =>
      entry.username === user.username
        ? { ...entry, is_following: !entry.is_following, following_count: result.following_count }
        : entry,
    );
  } catch (error) {
    console.error('Follow/unfollow error:', error);
  } finally {
    busy = { ...busy, [user.username]: false };
  }
}

function openProfile(user: UserListItem): void {
  void navigate(`/profile/${user.username}`);
}

function avatarUrl(user: UserListItem): string | null {
  return user.avatar_key ? nativeApiHref(`/api/images/${user.avatar_key}`) : null;
}

onMount(() => {
  const unregister = registerModal();
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  };
  document.addEventListener('keydown', onKey);
  void load(true);
  return () => {
    document.removeEventListener('keydown', onKey);
    unregister();
  };
});
</script>

<div
  class="follow-overlay"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <div class="follow-modal" role="dialog" aria-modal="true" aria-label={t('follower_list.title', { username, tab: tabLabel })}>
    <div class="follow-header">
      <h2>{t('follower_list.title', { username, tab: tabLabel })}</h2>
      <button type="button" class="follow-close" aria-label={t('common.close') || 'Close'} onclick={onClose}>×</button>
    </div>

    <div class="follow-tabs">
      <button type="button" class="follow-tab" class:follow-tab--active={tab === 'followers'} onclick={() => switchTab('followers')}>
        {t('follower_list.followers')}
      </button>
      <button type="button" class="follow-tab" class:follow-tab--active={tab === 'following'} onclick={() => switchTab('following')}>
        {t('follower_list.following')}
      </button>
    </div>

    <div class="follow-content">
      {#if loading && users.length === 0}
        <div class="follow-status">{t('common.loading')}</div>
      {:else if failed}
        <div class="follow-status follow-status--error">{t('follower_list.error')}</div>
      {:else if users.length === 0}
        <div class="follow-status follow-empty">
          <div class="follow-empty-icon">👥</div>
          <div>{t('follower_list.empty')}</div>
        </div>
      {:else}
        {#each users as user (user.id)}
          <div class="follow-user">
            <button type="button" class="follow-user-link" onclick={() => openProfile(user)}>
              <span
                class="follow-avatar"
                use:mountBadge={user.badge_type}
                style:background-image={avatarUrl(user) ? `url(${avatarUrl(user)})` : undefined}
              >
                {#if !avatarUrl(user)}
                  {user.username.charAt(0).toUpperCase()}
                {/if}
              </span>
              <span class="follow-info">
                <span class="follow-name" use:renderName={user}>{user.display_name}</span>
                <span class="follow-username">@{user.username}</span>
              </span>
            </button>
            {#if currentUser && user.username !== currentUser.username}
              <button
                type="button"
                class="follow-button"
                class:follow-button--active={user.is_following}
                disabled={busy[user.username]}
                onclick={() => void toggleFollow(user)}
              >
                {user.is_following ? t('profile.following') : t('profile.follow')}
              </button>
            {/if}
          </div>
        {/each}
        {#if hasMore}
          <button type="button" class="follow-more" disabled={loading} onclick={() => void load(false)}>
            {t('follower_list.load_more')}
          </button>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .follow-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.5);
  }

  .follow-modal {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 600px;
    max-height: 80vh;
    border-radius: 0.5rem;
    background: var(--bg-primary);
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  }

  .follow-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .follow-header h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: 1.25rem;
    font-weight: 600;
  }

  .follow-close {
    padding: 0.25rem 0.5rem;
    border: 0;
    border-radius: 0.25rem;
    background: none;
    color: var(--text-muted);
    font-size: 1.5rem;
    cursor: pointer;
  }

  .follow-close:hover {
    background: var(--bg-secondary);
  }

  .follow-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
  }

  .follow-tab {
    flex: 1;
    padding: 1rem;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-muted);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .follow-tab--active {
    border-bottom-color: var(--accent);
    color: var(--text-primary);
  }

  .follow-content {
    flex: 1;
    overflow-y: auto;
  }

  .follow-status {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3rem;
    color: var(--text-muted);
  }

  .follow-status--error {
    color: var(--danger-text);
    text-align: center;
  }

  .follow-empty {
    flex-direction: column;
    gap: 0.5rem;
    text-align: center;
  }

  .follow-empty-icon {
    font-size: 2rem;
  }

  .follow-user {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--border);
  }

  .follow-user-link {
    display: flex;
    flex: 1;
    align-items: center;
    min-width: 0;
    padding: 1rem 1.5rem;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .follow-user-link:hover {
    background: var(--bg-secondary);
  }

  .follow-avatar {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    margin-right: 1rem;
    border-radius: 50%;
    background-color: var(--bg-secondary);
    background-position: center;
    background-size: cover;
    color: var(--text-muted);
    font-weight: 600;
  }

  .follow-info {
    min-width: 0;
  }

  .follow-name {
    display: block;
    overflow: hidden;
    color: var(--text-primary);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .follow-username {
    display: block;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 0.875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .follow-button {
    flex-shrink: 0;
    margin: 0 1.5rem 0 1rem;
    padding: 0.5rem 1rem;
    border: 1px solid var(--border);
    border-radius: 9999px;
    background: transparent;
    color: var(--text-primary);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .follow-button--active {
    border-color: var(--accent);
    background: var(--accent);
    color: white;
  }

  .follow-more {
    width: 100%;
    padding: 1rem;
    border: 0;
    border-top: 1px solid var(--border);
    background: none;
    color: var(--text-muted);
    font-size: 0.875rem;
    cursor: pointer;
  }

  .follow-more:hover {
    background: var(--bg-secondary);
  }
</style>
