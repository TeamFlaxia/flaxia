<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import { applyNameColor } from '../../../shared/name-color.ts';
import { clearMeCache } from '../auth-cache';
import { clearDeletionOperation, deletionOperationFor } from '../auth-deletion';
import { createSrpProof as srpProofFor } from '../auth-srp.js';
import { attachPlusBadge } from '../avatar.js';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { t } from '../i18n.ts';
import { nativeApiHref } from '../native-api.ts';

interface AccountUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
}

let { currentUser }: { currentUser: AccountUser } = $props();

let avatarWrap: HTMLDivElement;
let nameEl: HTMLDivElement;

const displayName = $derived(currentUser.display_name || currentUser.username);
const avatarUrl = $derived(
  nativeApiHref(currentUser.avatar_key ? `/api/images/${currentUser.avatar_key}` : '/api/images/default-avatar'),
);

async function logout(): Promise<void> {
  if (!(await confirmDialog(t('auth.logout_confirm', { username: currentUser.username })))) return;
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    if (response.ok) {
      clearMeCache();
      window.location.href = '/';
    } else {
      alert(t('auth.logout_failed'));
    }
  } catch (error) {
    console.error('Logout error:', error);
    alert(t('auth.logout_error'));
  }
}

async function deleteAccount(): Promise<void> {
  if (!(await confirmDialog(t('settings.delete_account_confirm', { username: currentUser.username })))) return;
  const password = window.prompt(t('settings.current_password') || 'Enter your current password to confirm deletion');
  if (!password) return;
  try {
    const current_srp = await srpProofFor(password);
    if (!current_srp) {
      alert(t('settings.password_proof_failed') || 'Could not verify your password');
      return;
    }
    const operation = deletionOperationFor(currentUser.id);
    const response = await fetch('/api/users/me', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ current_srp, operation }),
    });

    if (response.ok) {
      clearDeletionOperation();
      clearMeCache();
      window.location.href = '/';
    } else {
      const data = (await response.json().catch(() => ({}))) as { cancelled?: boolean };
      if (data.cancelled) clearDeletionOperation();
      alert(t('settings.delete_account_failed'));
    }
  } catch (error) {
    console.error('Delete account error:', error);
    alert(t('settings.delete_account_error'));
  }
}

onMount(() => {
  if (avatarWrap) attachPlusBadge(avatarWrap, currentUser.badge_type);
  if (nameEl) applyNameColor(nameEl, currentUser.name_color, currentUser.badge_type);
});
</script>

<h2>{t('settings.account')}</h2>

<div class="settings-user">
  <div class="settings-user-avatar" bind:this={avatarWrap}>
    <img
      src={avatarUrl}
      alt=""
      class="settings-user-avatar-img"
      onerror={(event) => {
        event.currentTarget.src = nativeApiHref('/api/images/default-avatar');
      }}
    />
  </div>
  <div class="settings-user-info">
    <div class="settings-user-name" bind:this={nameEl}>{displayName}</div>
    <div class="settings-user-username">@{currentUser.username}</div>
  </div>
</div>

<div class="settings-account-actions">
  <button class="settings-button" onclick={() => void logout()}>{t('auth.sign_out')}</button>
  <button class="settings-button settings-button--danger" onclick={() => void deleteAccount()}>
    {t('settings.delete_account')}
  </button>
</div>
