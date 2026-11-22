<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import type { AdminUser } from '../admin/users-types.ts';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { formatCount } from '../format.ts';
import { t } from '../i18n.ts';

let users = $state<AdminUser[]>([]);
let searchQuery = $state('');
let loaded = $state(false);

const filteredUsers = $derived.by(() => {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return users;
  return users.filter(
    (user) => user.username.toLowerCase().includes(query) || user.email.toLowerCase().includes(query),
  );
});

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function isTargetAdmin(user: AdminUser): boolean {
  return user.is_admin ?? user.role === 'admin';
}

async function fetchUsers(): Promise<AdminUser[]> {
  try {
    const response = await fetch('/api/admin/users', { credentials: 'include' });
    if (response.status === 403) return [];
    if (!response.ok) throw new Error('Failed to fetch users');
    const data = (await response.json()) as { users: AdminUser[] };
    return data.users;
  } catch (error) {
    console.error('Fetch users error:', error);
    return [];
  }
}

async function deleteUser(user: AdminUser): Promise<void> {
  if (!(await confirmDialog(t('admin_users.delete_confirm', { username: user.username })))) return;
  try {
    const response = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE', credentials: 'include' });
    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error || 'Failed to delete user');
    }
    users = users.filter((entry) => entry.id !== user.id);
  } catch (error) {
    console.error('Delete user error:', error);
  }
}

async function setUserFrozen(user: AdminUser, frozen: boolean, reason = ''): Promise<boolean> {
  try {
    const action = frozen ? 'freeze' : 'unfreeze';
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/${action}`, {
      method: 'POST',
      credentials: 'include',
      headers: frozen ? { 'Content-Type': 'application/json' } : undefined,
      body: frozen ? JSON.stringify({ reason }) : undefined,
    });
    if (!response.ok) {
      const error = (await response.json()) as { error?: string };
      throw new Error(error.error || 'Failed to update account status');
    }
    const frozenAt = frozen ? new Date().toISOString() : null;
    users = users.map((entry) =>
      entry.id === user.id ? { ...entry, frozen_at: frozenAt, frozen_reason: frozen ? reason : null } : entry,
    );
    return true;
  } catch (error) {
    console.error('Update account status error:', error);
    alert(t('admin_users.freeze_failed'));
    return false;
  }
}

async function toggleFreeze(user: AdminUser): Promise<void> {
  const isFrozen = Boolean(user.frozen_at);
  let reason = '';
  if (!isFrozen) {
    const enteredReason = window.prompt(t('admin_users.freeze_reason_prompt'));
    if (enteredReason === null) return;
    reason = enteredReason.trim();
    if (!reason) {
      alert(t('admin_users.freeze_reason_required'));
      return;
    }
    if (reason.length > 500) {
      alert(t('admin_users.freeze_reason_too_long'));
      return;
    }
  }
  const messageKey = isFrozen ? 'admin_users.unfreeze_confirm' : 'admin_users.freeze_confirm';
  if (!(await confirmDialog(t(messageKey, { username: user.username, reason })))) return;
  await setUserFrozen(user, !isFrozen, reason);
}

onMount(() => {
  void (async () => {
    users = await fetchUsers();
    loaded = true;
  })();
});
</script>

<div class="users">
  <h2>{t('admin_users.title')}</h2>

  <div class="users-count">
    <span class="users-count-label">{t('admin_users.total_users')}</span>
    <span class="users-count-number">{formatCount(users.length)}</span>
  </div>

  <div class="users-search">
    <input type="text" placeholder={t('admin_users.search_placeholder')} bind:value={searchQuery} />
  </div>

  <div class="users-header">
    <span class="users-col users-col--username">{t('admin_users.header_username')}</span>
    <span class="users-col users-col--display">{t('admin_users.header_display_name')}</span>
    <span class="users-col users-col--email">{t('admin_users.header_email')}</span>
    <span class="users-col users-col--joined">{t('admin_users.header_joined')}</span>
  </div>

  <div class="users-body">
    {#each filteredUsers as user (user.id)}
      <div class="users-row">
        <span class="users-name">@{user.username}</span>
        <span class="users-display">{user.display_name}</span>
        <span class="users-email" title={user.email}>{user.email}</span>
        <span class="users-joined">{formatDate(user.created_at)}</span>

        {#if isTargetAdmin(user)}
          <span class="users-badge users-badge--admin">{t('admin_users.admin_badge')}</span>
        {:else}
          {#if user.frozen_at}
            <span class="users-badge users-badge--frozen" title={user.frozen_reason ?? ''}>
              {t('admin_users.frozen_badge')}
            </span>
          {/if}
          <button
            type="button"
            class="users-btn"
            class:users-btn--unfreeze={!!user.frozen_at}
            onclick={() => void toggleFreeze(user)}
          >
            {t(user.frozen_at ? 'admin_users.unfreeze_account' : 'admin_users.freeze_account')}
          </button>
          <button type="button" class="users-btn users-btn--delete" onclick={() => void deleteUser(user)}>
            {t('admin_users.delete_account')}
          </button>
        {/if}
      </div>
    {/each}

    {#if loaded && filteredUsers.length === 0}
      <div class="users-empty">
        {searchQuery.trim() ? t('admin_users.no_results') : t('admin_users.empty')}
      </div>
    {/if}
  </div>
</div>

<style>
  .users {
    max-width: 900px;
  }

  h2 {
    color: #f1f5f9;
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 16px;
  }

  .users-count {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 16px;
    color: #f1f5f9;
  }

  .users-count-label {
    color: #94a3b8;
    font-weight: 500;
  }

  .users-count-number {
    color: #22c55e;
    font-weight: 600;
    font-size: 18px;
  }

  .users-search {
    margin-bottom: 16px;
  }

  .users-search input {
    width: 100%;
    max-width: 300px;
    padding: 10px 14px;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    color: #f1f5f9;
    font-size: 14px;
  }

  .users-header {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    background: #0f172a;
    border-radius: 8px 8px 0 0;
    gap: 12px;
    font-size: 12px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .users-col--username {
    min-width: 150px;
  }

  .users-col--display {
    min-width: 120px;
  }

  .users-col--email {
    min-width: 200px;
  }

  .users-col--joined {
    margin-left: auto;
  }

  .users-body {
    background: #1e293b;
    border-radius: 0 0 8px 8px;
  }

  .users-row {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #1e293b;
    gap: 12px;
    flex-wrap: wrap;
  }

  .users-name {
    color: #22c55e;
    font-size: 14px;
    font-weight: 500;
    min-width: 150px;
  }

  .users-display {
    color: #f1f5f9;
    font-size: 14px;
    min-width: 120px;
  }

  .users-email {
    color: #94a3b8;
    font-size: 14px;
    min-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .users-joined {
    color: #64748b;
    font-size: 13px;
    margin-left: auto;
  }

  .users-badge {
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
  }

  .users-badge--frozen {
    background: #ef444420;
    color: #fca5a5;
    border: 1px solid #ef444440;
  }

  .users-badge--admin {
    background: #22c55e20;
    color: #22c55e;
    border: 1px solid #22c55e40;
  }

  .users-btn {
    background: #7f1d1d;
    color: #f1f5f9;
    border: none;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.2s;
  }

  .users-btn--unfreeze {
    background: #166534;
  }

  .users-btn--delete {
    background: #334155;
  }

  .users-empty {
    color: #64748b;
    font-size: 14px;
    padding: 24px;
    text-align: center;
  }
</style>
