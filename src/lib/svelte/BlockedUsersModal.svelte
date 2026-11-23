<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { resolveNameColor } from '../../../shared/name-color.ts';
import { attachPlusBadge } from '../avatar.ts';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.ts';
import { t } from '../i18n.ts';
import { blockedAvatarPath, removeBlockedUser, unblockEndpoint } from '../modals/dialog-logic.ts';
import { attachModalBehavior, type ModalBehavior } from '../modals/modal-behavior.ts';
import { nativeApiHref } from '../native-api.ts';

interface BlockedUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
}

interface Props {
  onUnblock?: (username: string) => void;
  onClose: () => void;
}

let { onUnblock, onClose }: Props = $props();

let overlayEl: HTMLDivElement;
let dialogEl: HTMLDivElement;
let controller: ModalBehavior | null = null;
let users = $state<BlockedUser[]>([]);
let loading = $state(true);
let loadFailed = $state(false);
let message = $state('');
let messageKind = $state<'success' | 'danger'>('success');
let busy = $state<Record<string, boolean>>({});
let removing = $state<Record<string, boolean>>({});

function mountBadge(node: HTMLElement, badge: string | null | undefined): void {
  attachPlusBadge(node, badge);
}

function avatarUrl(user: BlockedUser): string {
  return nativeApiHref(blockedAvatarPath(user.avatar_key));
}

function nameColor(user: BlockedUser): string | null {
  return resolveNameColor(user.name_color, user.badge_type);
}

async function load(): Promise<void> {
  try {
    const response = await fetch('/api/users/me/blocked', { credentials: 'include' });
    if (!response.ok) {
      loadFailed = true;
      message = t('settings.blocked_load_failed');
      messageKind = 'danger';
      return;
    }
    const data = (await response.json()) as { users: BlockedUser[] };
    users = data.users;
  } catch {
    loadFailed = true;
    message = t('settings.blocked_load_failed');
    messageKind = 'danger';
  } finally {
    loading = false;
  }
}

async function unblock(user: BlockedUser): Promise<void> {
  const confirmed = await confirmDialog(t('settings.blocked_unblock_confirm', { username: `@${user.username}` }));
  if (!confirmed) return;

  busy = { ...busy, [user.username]: true };
  try {
    const response = await fetch(unblockEndpoint(user.username), {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Failed to unblock');

    message = t('settings.blocked_unblocked');
    messageKind = 'success';
    removing = { ...removing, [user.username]: true };
    onUnblock?.(user.username);
    window.setTimeout(() => {
      users = removeBlockedUser(users, user.username);
      const nextRemoving = { ...removing };
      delete nextRemoving[user.username];
      removing = nextRemoving;
    }, 300);
  } catch {
    message = t('settings.blocked_unblock_failed');
    messageKind = 'danger';
    busy = { ...busy, [user.username]: false };
  }
}

onMount(() => {
  controller = attachModalBehavior({
    overlay: overlayEl,
    dialog: dialogEl,
    onClose,
    animated: false,
  });
  void load();
  return () => controller?.destroy();
});
</script>

<div
  class="blocked-overlay"
  bind:this={overlayEl}
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) controller?.close();
  }}
>
  <div
    class="blocked-dialog"
    bind:this={dialogEl}
    role="dialog"
    aria-modal="true"
    aria-labelledby="blocked-users-title"
    tabindex="-1"
  >
    <div class="blocked-header">
      <h2 id="blocked-users-title">{t('settings.blocked_users')}</h2>
      <button type="button" class="blocked-close" aria-label={t('common.close')} onclick={() => controller?.close()}>
        ×
      </button>
    </div>

    <div class="blocked-body">
      <div class="blocked-message" class:blocked-message--danger={messageKind === 'danger'} class:blocked-message--success={messageKind === 'success'} aria-live="polite">
        {message}
      </div>

      {#if !loading && !loadFailed && users.length === 0}
        <div class="blocked-empty">{t('settings.blocked_empty')}</div>
      {:else if users.length > 0}
        <div class="blocked-list">
          {#each users as user (user.id)}
            <div class="blocked-row" class:blocked-row--removing={removing[user.username]}>
              <div class="blocked-avatar" use:mountBadge={user.badge_type}>
                <img
                  src={avatarUrl(user)}
                  alt=""
                  onerror={(event) => {
                    event.currentTarget.src = nativeApiHref('/api/images/default-avatar');
                  }}
                />
              </div>
              <div class="blocked-info">
                <div class="blocked-name" style:color={nameColor(user) ?? undefined}>
                  {user.display_name || user.username}
                </div>
                <div class="blocked-username">@{user.username}</div>
              </div>
              <button
                type="button"
                class="blocked-unblock"
                disabled={busy[user.username]}
                onclick={() => void unblock(user)}
              >
                {t('settings.blocked_unblock')}
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .blocked-overlay {
    position: fixed;
    inset: 0;
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
  }

  .blocked-dialog {
    display: flex;
    flex-direction: column;
    width: 90%;
    max-width: 480px;
    max-height: 80vh;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-primary);
  }

  .blocked-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .blocked-header h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: 1.125rem;
    font-weight: 600;
  }

  .blocked-close {
    padding: 0 0.25rem;
    border: 0;
    background: none;
    color: var(--text-muted);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
  }

  .blocked-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
  }

  .blocked-message {
    min-height: 1.25rem;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
  }

  .blocked-message--success {
    color: var(--success, #10b981);
  }

  .blocked-message--danger {
    color: var(--danger);
  }

  .blocked-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .blocked-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    transition:
      opacity 0.3s,
      transform 0.3s;
  }

  .blocked-row--removing {
    opacity: 0;
    transform: translateX(-100%);
  }

  .blocked-avatar {
    position: relative;
    flex-shrink: 0;
    width: 40px;
    height: 40px;
  }

  .blocked-avatar img {
    display: block;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    object-fit: cover;
  }

  .blocked-info {
    flex: 1;
    min-width: 0;
  }

  .blocked-name {
    overflow: hidden;
    color: var(--text-primary);
    font-size: 0.9375rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .blocked-username {
    overflow: hidden;
    color: var(--text-muted);
    font-size: 0.8125rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .blocked-unblock {
    padding: 0.5rem 1rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    color: var(--text-primary);
    font-size: 0.8125rem;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.2s;
  }

  .blocked-unblock:hover {
    background: var(--bg-secondary);
  }

  .blocked-unblock:disabled {
    opacity: 0.5;
  }

  .blocked-empty {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
</style>
