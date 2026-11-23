<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedImports: types and markup-only helpers
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// Compact vault unlock form for screens outside Settings (currently Mail
// settings). The full setup/recovery/device-management UI stays in
// SettingsVaultSection; this only unlocks VK with the password (or the device
// key) and points the user at Settings for setup or QR pairing.
import { onDestroy, onMount } from 'svelte';
import { t } from '../i18n.ts';
import { navigate } from '../navigation.ts';
import { vaultUnlockFailureKey, vaultUnlockView } from '../settings/vault-unlock-state.ts';
import { fetchVaultKeys } from '../vault/client.js';
import { isVaultUnlocked, tryDeviceUnlock, unlockVault } from '../vault/session.js';

let { onUnlocked }: { onUnlocked: () => void } = $props();

let enabled = $state<boolean | null>(null);
let loadError = $state(false);
let busy = $state(false);
let message = $state('');
let password = $state('');
let input = $state<HTMLInputElement>();
let done = false;
let destroyed = false;

const view = $derived(vaultUnlockView(enabled, loadError));

function finish(): void {
  if (done || destroyed) return;
  done = true;
  onUnlocked();
}

async function init(): Promise<void> {
  if (isVaultUnlocked()) {
    finish();
    return;
  }
  if (await tryDeviceUnlock()) {
    finish();
    return;
  }
  const keys = await fetchVaultKeys();
  if (destroyed) return;
  if (!keys) {
    loadError = true;
    return;
  }
  enabled = keys.enabled === true;
}

async function unlock(): Promise<void> {
  if (!password || busy || done) return;
  busy = true;
  const outcome = await unlockVault(password);
  busy = false;
  if (outcome === 'ok') {
    finish();
    return;
  }
  message = t(vaultUnlockFailureKey(outcome === 'malformed' ? 'error' : outcome));
  input?.focus();
}

function retry(): void {
  loadError = false;
  enabled = null;
  message = '';
  void init();
}

function openSettings(): void {
  void navigate('/settings');
}

onMount(() => {
  void init();
});

onDestroy(() => {
  destroyed = true;
});

$effect(() => {
  if (view === 'locked' && !busy) input?.focus();
});
</script>

<div class="vault-unlock-form">
  {#if view === 'loading'}
    <p class="vault-unlock-muted">{t('settings.vault_awaiting') || 'Checking vault status…'}</p>
  {:else if view === 'error'}
    <p class="vault-unlock-message" role="alert">{t('settings.network_error') || 'Network error'}</p>
    <button type="button" class="vault-unlock-secondary" onclick={retry}>
      {t('common.retry') || 'Retry'}
    </button>
  {:else if view === 'unavailable'}
    <p class="vault-unlock-muted">
      {t('settings.vault_not_setup') || 'The Personal Vault is not set up yet. Set it up in Settings first.'}
    </p>
    <button type="button" class="vault-unlock-secondary" onclick={openSettings}>
      {t('settings.vault_open_settings') || 'Open Settings'}
    </button>
  {:else}
    <p class="vault-unlock-muted">
      {t('settings.vault_locked_hint') || 'Unlock with your account password, or pair this device by QR code.'}
    </p>
    <label class="vault-unlock-label" for="vault-unlock-form-password">{t('settings.vault_password') || 'Account password'}</label>
    <input
      id="vault-unlock-form-password"
      bind:this={input}
      bind:value={password}
      class="vault-unlock-input"
      type="password"
      autocomplete="current-password"
      placeholder={t('settings.vault_password_ph') || 'Your account password'}
      onkeydown={(event) => {
        if (event.key === 'Enter') void unlock();
      }}
    />
    <button type="button" class="vault-unlock-primary" disabled={busy} onclick={() => void unlock()}>
      {busy ? t('settings.vault_working') || 'Working…' : t('settings.vault_unlock') || 'Unlock'}
    </button>
    <div class="vault-unlock-actions">
      <button type="button" class="vault-unlock-secondary" onclick={openSettings}>
        {t('settings.vault_pair_in_settings') || 'Pair this device in Settings'}
      </button>
    </div>
    <p class="vault-unlock-message" role="alert">{message}</p>
  {/if}
</div>

<style>
  .vault-unlock-label {
    display: block;
    margin-bottom: 0.5rem;
    color: var(--text-primary);
    font-weight: 500;
  }

  .vault-unlock-input {
    box-sizing: border-box;
    width: 100%;
    margin-bottom: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 1rem;
  }

  .vault-unlock-primary {
    padding: 0.6rem 1.25rem;
    border: 0;
    border-radius: 4px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 0.9rem;
    cursor: pointer;
  }

  .vault-unlock-secondary {
    padding: 0.6rem 1.25rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.9rem;
    cursor: pointer;
  }

  .vault-unlock-muted {
    margin: 0.5rem 0;
    color: var(--text-secondary);
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .vault-unlock-message {
    min-height: 1.1em;
    margin-top: 0.75rem;
    color: var(--danger);
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .vault-unlock-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
  }
</style>
