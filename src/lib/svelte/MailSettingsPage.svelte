<script lang="ts">
import { onMount, tick } from 'svelte';
import { primaryAddressForUsername } from '../../../shared/mail-address.ts';
import { t } from '../i18n.ts';
import { activateMailAddress } from '../mail/activate.ts';
import { getQuota, listAddresses } from '../mail/api.ts';
import { goToMail, mailBack } from '../mail/navigation.ts';
import { mountVaultUnlock } from '../mail/vault-unlock.ts';
import { iconHtml } from '../post/icon-html.ts';
import { isVaultUnlocked } from '../vault/session.ts';

interface Props {
  currentUser: { id: string; username: string } | null;
}

let { currentUser }: Props = $props();

let address = $state('');
let invalidUsername = $state(false);
let loading = $state(true);
let active = $state(false);
let quota = $state<Awaited<ReturnType<typeof getQuota>> | null>(null);
let vaultUnlocked = $state(false);
let message = $state('');

function vaultUnlock(node: HTMLElement) {
  const form = mountVaultUnlock(node, () => {
    vaultUnlocked = true;
    void refresh();
  });
  return { destroy: () => form.destroy() };
}

async function refresh(): Promise<void> {
  if (!currentUser) return;
  loading = true;
  vaultUnlocked = isVaultUnlocked();
  try {
    address = primaryAddressForUsername(currentUser.username);
  } catch {
    invalidUsername = true;
    loading = false;
    return;
  }
  const [addresses, quotaResult] = await Promise.all([
    listAddresses().catch(() => ({ addresses: [] })),
    getQuota().catch(() => null),
  ]);
  const mine = addresses.addresses.find((entry) => entry.address === address);
  active = mine?.state === 'active';
  quota = quotaResult;
  loading = false;
}

async function activate(): Promise<void> {
  if (!currentUser || !vaultUnlocked) return;
  message = '';
  try {
    await activateMailAddress(currentUser.username);
    await refresh();
  } catch (error) {
    const code = (error as Error).message;
    if (code.includes('mail_vault_required')) {
      vaultUnlocked = false;
      await tick();
      return;
    }
    message = code;
  }
}

onMount(() => {
  void refresh();
});

const usedBytes = $derived(Math.max(0, quota?.storage_bytes ?? 0));
const totalBytes = $derived(Math.max(1, quota?.storage_quota_bytes ?? 1));
const percent = $derived(Math.min(100, (usedBytes / totalBytes) * 100));

const securityRows = [
  {
    icon: 'shield',
    titleKey: 'mail.security_e2ee',
    noteKey: 'mail.security_e2ee_note',
    title: 'End-to-end encrypted',
    note: 'Flaxia to Flaxia: only the members hold the keys.',
  },
  {
    icon: 'lock',
    titleKey: 'mail.security_at_rest',
    noteKey: 'mail.security_at_rest_note',
    title: 'Encrypted at rest',
    note: 'External inbound mail is encrypted before it is stored.',
  },
  {
    icon: 'mail-open',
    titleKey: 'mail.security_tls',
    noteKey: 'mail.security_tls_note',
    title: 'TLS only',
    note: 'External outbound mail is protected in transit, not E2EE.',
  },
] as const;
</script>

<div class="mail-settings-page">
  <header class="page-header mail-settings-header">
    <button
      type="button"
      class="page-header-back"
      aria-label={t('mail.back') || 'Back to Mail'}
      onclick={() => mailBack()}
    >
      {@html iconHtml('arrow-left', 17)}
    </button>
    <div class="page-header-titles">
      <h1 class="page-header-title">{t('mail.settings_title') || 'Mail settings'}</h1>
      <span class="page-header-subtitle">
        {t('mail.settings_subtitle') || 'Address, storage and encryption'}
      </span>
    </div>
  </header>

  <div class="mail-settings-content">
    {#if !currentUser}
      <p class="mail-settings-muted">{t('mail.requires_login') || 'Sign in to use Mail.'}</p>
    {:else if invalidUsername}
      <p class="mail-settings-muted">{t('mail.invalid_username') || 'Your username cannot be a Mail address.'}</p>
    {:else if loading}
      <p class="mail-settings-muted">{t('common.loading')}</p>
    {:else}
      <section class="mail-settings-card">
        <div class="mail-settings-card-head">
          <h2>{t('mail.settings_mailbox') || 'Mailbox'}</h2>
          <span class="mail-status-pill" class:mail-status-pill--active={active} class:mail-status-pill--idle={!active}>
            {active ? t('mail.status_active') || 'Active' : t('mail.status_inactive') || 'Not activated'}
          </span>
        </div>

        <div class="mail-settings-address-row">
          <span class="mail-avatar">{address.slice(0, 1).toUpperCase()}</span>
          <div class="mail-settings-identity">
            <span class="mail-settings-address">{address}</span>
            <span class="mail-settings-note">
              {active
                ? t('mail.address_active_note') || 'Incoming mail is encrypted in this mailbox.'
                : t('mail.address_inactive_note') || 'Activate to receive mail at this address.'}
            </span>
          </div>
        </div>

        {#if !active}
          <div class="mail-settings-vault">
            <div class="mail-settings-vault-status">
              {@html iconHtml(vaultUnlocked ? 'shield' : 'lock', 16)}
              <span>
                {vaultUnlocked
                  ? t('mail.vault_unlocked') || 'Personal Vault: unlocked'
                  : t('mail.vault_locked') || 'Personal Vault: locked (unlock below to activate Mail)'}
              </span>
            </div>
          </div>

          {#if !vaultUnlocked}
            <div use:vaultUnlock></div>
          {/if}

          <button
            type="button"
            class="mail-button mail-button--primary"
            disabled={!vaultUnlocked}
            onclick={() => void activate()}
          >
            {@html iconHtml('check', 15)}
            <span>{t('mail.activate') || 'Activate Mail address'}</span>
          </button>
          <p class="mail-settings-message">{message}</p>
        {:else}
          <button type="button" class="mail-button mail-button--secondary" onclick={() => goToMail()}>
            {@html iconHtml('mail', 15)}
            <span>{t('mail.open_mail') || 'Open Mail'}</span>
          </button>
        {/if}
      </section>

      <section class="mail-settings-card">
        <h2>{t('mail.settings_storage') || 'Storage'}</h2>
        {#if !quota}
          <p class="mail-settings-muted">
            {t('mail.quota_unavailable') || 'Storage usage is unavailable right now.'}
          </p>
        {:else}
          <div
            class="mail-quota-bar"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round(percent)}
          >
            <span style={`--mail-quota: ${percent}%; width: ${percent}%`}></span>
          </div>
          <div class="mail-quota-meta">
            <span>
              {(t('mail.quota') || 'Storage: {used} MiB / {total} MiB')
                .replace('{used}', String(Math.round(usedBytes / 1024 / 1024)))
                .replace('{total}', String(Math.round(totalBytes / 1024 / 1024)))}
            </span>
            <span>
              {(t('mail.external_sends') || '{count}/{limit} external sends today')
                .replace('{count}', String(quota.external_sends))
                .replace('{limit}', String(quota.daily_external_limit))}
            </span>
          </div>
        {/if}
      </section>

      <section class="mail-settings-card">
        <h2>{t('mail.settings_security') || 'Encryption'}</h2>
        <ul class="mail-security-list">
          {#each securityRows as row (row.titleKey)}
            <li>
              <span class="mail-security-icon">{@html iconHtml(row.icon, 16)}</span>
              <span>
                <strong>{t(row.titleKey) || row.title}</strong>
                <span>{t(row.noteKey) || row.note}</span>
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</div>
