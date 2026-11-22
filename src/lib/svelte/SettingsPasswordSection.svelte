<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
import { onMount } from 'svelte';
import {
  clearCredentialOperation,
  credentialOperationFor,
  retryPendingCredentialChange,
} from '../auth-credential-operation';
import { createSrpProof as srpProofFor, storeSrpSalt } from '../auth-srp.js';
import { createConfirmDialog as confirmDialog } from '../confirm-dialog.js';
import { t } from '../i18n.ts';
import { passwordLengthError } from '../password-policy.js';
import { computeVerifier, DEFAULT_SRP_KDF, generateSalt } from '../srp.js';
import { fetchVaultKeys, prepareVaultRewrap } from '../vault/client.js';
import { syncVaultVersionAfterRewrap } from '../vault/session.js';

interface PasswordUser {
  id: string;
}

let { currentUser }: { currentUser: PasswordUser | null } = $props();

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

const recovering = sessionStorage.getItem('flaxia.recovery-login') === '1';
let currentPassword = $state('');
let newPassword = $state('');
let confirmPassword = $state('');
let message = $state('');
let tone = $state<'accent' | 'danger' | 'success'>('accent');
let saving = $state(false);
let recoveryVisible = $state(false);
let recoveryBusy = $state(false);

function show(text: string, nextTone: 'accent' | 'danger' | 'success' = 'danger'): void {
  message = text;
  tone = nextTone;
}

function toneColor(): string | undefined {
  if (!message) return undefined;
  if (tone === 'accent') return 'var(--accent-text)';
  if (tone === 'success') return 'var(--success, #10b981)';
  return 'var(--danger-text)';
}

async function enrollRecovery(): Promise<void> {
  const password = window.prompt(t('settings.recovery_current_password'));
  if (!password) return;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const code = b64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  if (!(await confirmDialog(`${t('settings.recovery_save_code')}\n\n${code}`))) return;
  recoveryBusy = true;
  try {
    const salt = generateSalt();
    const verifier = await computeVerifier(code, salt, DEFAULT_SRP_KDF);
    const proof = await srpProofFor(password);
    if (!proof) throw new Error('Recovery proof unavailable');
    const response = await fetch('/api/auth/recovery/enroll', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salt: b64(salt), verifier: b64(verifier), kdf: DEFAULT_SRP_KDF, current_srp: proof }),
    });
    window.alert(t(response.ok ? 'settings.recovery_enabled' : 'settings.recovery_failed'));
  } catch {
    window.alert(t('settings.recovery_failed'));
  } finally {
    recoveryBusy = false;
  }
}

async function savePassword(): Promise<void> {
  const current = currentPassword.trim();
  const next = newPassword.trim();
  const confirmation = confirmPassword.trim();

  if (!current || !next || !confirmation) {
    show(t('settings.password_fill_all'));
    return;
  }
  if (next !== confirmation) {
    show(t('settings.password_mismatch'));
    return;
  }
  if (passwordLengthError(next)) {
    show(t('settings.password_length'));
    return;
  }

  message = '';
  saving = true;
  try {
    if (!currentUser) return;
    const previous = await retryPendingCredentialChange();
    if (previous === 'committed') {
      show(t('settings.password_previous_completed'), 'success');
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
      return;
    }
    if (previous === 'pending') {
      show(t('settings.password_change_pending'));
      return;
    }
    const salt = generateSalt();
    const verifier = await computeVerifier(next, salt, DEFAULT_SRP_KDF);

    const currentSrp = await srpProofFor(current, recovering);
    if (!currentSrp) {
      show(t('settings.current_password_incorrect'));
      return;
    }

    let vaultSecret = current;
    if (recovering) {
      const keys = await fetchVaultKeys();
      if (!keys) throw new Error('Vault unavailable');
      if (keys.enabled) {
        const phrase = window.prompt(t('settings.recovery_vault_phrase'));
        if (!phrase) return;
        vaultSecret = phrase;
      }
    }
    const vaultRewrap = await prepareVaultRewrap(vaultSecret, next, recovering);
    if (vaultRewrap.status === 'unlock_failed') {
      show(t('settings.current_password_incorrect'));
      return;
    }
    if (vaultRewrap.status === 'error') {
      show(t('settings.password_save_failed'));
      return;
    }

    const operation = credentialOperationFor(currentUser.id);
    const response = await fetch('/api/users/me/password', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srp_salt: b64(salt),
        srp_verifier: b64(verifier),
        srp_group: '2048',
        srp_kdf: DEFAULT_SRP_KDF,
        current_srp: currentSrp,
        operation,
        ...(recovering ? { recovery: true } : {}),
        ...(vaultRewrap.status === 'ok' ? { vault_kek: vaultRewrap.fields } : {}),
      }),
    });

    if (response.ok) {
      clearCredentialOperation();
      if (recovering) sessionStorage.removeItem('flaxia.recovery-login');
      storeSrpSalt(salt);
      if (vaultRewrap.status === 'ok') await syncVaultVersionAfterRewrap();
      show(t('settings.password_saved'), 'accent');
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
    } else {
      const errorData = (await response.json()) as { error?: string; cancelled?: boolean };
      if (errorData.cancelled) clearCredentialOperation();
      const text =
        errorData.error === 'vault_rewrap_required'
          ? t('settings.vault_rewrap_required')
          : errorData.error === 'vault_key_version_conflict'
            ? t('settings.vault_changed')
            : errorData.error || t('settings.password_save_failed');
      show(text);
    }
  } catch {
    show(t('settings.password_network_error'));
  } finally {
    saving = false;
  }
}

onMount(() => {
  void fetch('/api/auth/recovery/status', { credentials: 'include', cache: 'no-store' })
    .then((response) => {
      recoveryVisible = response.ok;
    })
    .catch(() => {});
});
</script>

<h2>{t('settings.change_password')}</h2>
<label class="settings-label" for="settings-password-current">
  {recovering ? t('settings.recovery_code_label') : t('settings.password_current')}
</label>
<input
  class="settings-input"
  id="settings-password-current"
  type="password"
  autocomplete="current-password"
  placeholder={recovering ? t('login.recovery_code_placeholder') : t('settings.password_current_placeholder')}
  bind:value={currentPassword}
/>
<label class="settings-label" for="settings-new-password">{t('settings.password_new')}</label>
<input
  class="settings-input"
  id="settings-new-password"
  type="password"
  autocomplete="new-password"
  placeholder={t('settings.password_new_placeholder')}
  bind:value={newPassword}
/>
<label class="settings-label" for="settings-confirm-password">{t('settings.password_confirm')}</label>
<input
  class="settings-input"
  id="settings-confirm-password"
  type="password"
  autocomplete="new-password"
  placeholder={t('settings.password_confirm_placeholder')}
  bind:value={confirmPassword}
/>
<button class="settings-save" disabled={saving} style:opacity={saving ? '0.6' : undefined} onclick={() => void savePassword()}>
  {t('common.save')}
</button>
<div class="settings-status" role="status" style:color={toneColor()}>{message}</div>
{#if recoveryVisible}
  <button
    type="button"
    class="settings-save"
    disabled={recoveryBusy}
    onclick={() => void enrollRecovery()}
  >
    {t('settings.recovery_create')}
  </button>
{/if}
