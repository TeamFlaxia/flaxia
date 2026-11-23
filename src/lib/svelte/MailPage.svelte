<script lang="ts">
import { onDestroy, onMount, tick } from 'svelte';
import { primaryAddressForUsername } from '../../../shared/mail-address.ts';
import { t } from '../i18n.ts';
import {
  applyMessageAction,
  getMailUnreadCount,
  isMailNotImplemented,
  listAddresses,
  listDrafts,
  listThreads,
  type MailFolder,
  type MailThreadSummary,
} from '../mail/api.ts';
import { goToMailCompose, goToMailSettings, goToMailThread } from '../mail/navigation.ts';
import { MailReader } from '../mail/reader.ts';
import { formatMailDate } from '../mail/ui.ts';
import { mountVaultUnlock } from '../mail/vault-unlock.ts';
import { iconHtml } from '../post/icon-html.ts';
import { uniqueBy } from '../unique.ts';
import { tryDeviceUnlock } from '../vault/session.ts';

type MailRow = MailThreadSummary & { messageId?: string };
interface Props {
  currentUser: { id: string; username: string } | null;
}

let { currentUser }: Props = $props();

const FOLDERS: Array<{ id: MailFolder; key: string; icon: string }> = [
  { id: 'inbox', key: 'mail.folder_inbox', icon: 'inbox' },
  { id: 'sent', key: 'mail.folder_sent', icon: 'send' },
  { id: 'drafts', key: 'mail.folder_drafts', icon: 'drafts' },
  { id: 'archive', key: 'mail.folder_archive', icon: 'archive' },
  { id: 'spam', key: 'mail.folder_spam', icon: 'warning' },
  { id: 'trash', key: 'mail.folder_trash', icon: 'trash' },
];

let folder = $state<MailFolder>('inbox');
let threads = $state<MailRow[]>([]);
let counts = $state<Partial<Record<MailFolder, number>>>({});
let unreadTotal = $state(0);
let search = $state('');
let address = $state('');
let active = $state(false);
let locked = $state(false);
let loading = $state(true);
let notReady = $state(false);
let loadError = $state('');
let invalidUsername = $state(false);
let destroyed = false;
let unlockHost: HTMLDivElement;
let unlockInstance: { destroy: () => void } | null = null;

const visible = $derived(
  threads.filter((t) =>
    search.trim()
      ? `${t.from_name} ${t.from_address} ${t.subject} ${t.snippet}`.toLowerCase().includes(search.trim().toLowerCase())
      : true,
  ),
);

function folderCount(id: MailFolder): number {
  return counts[id] ?? (id === 'inbox' ? unreadTotal : 0);
}

async function loadThreads(): Promise<void> {
  if (destroyed) return;
  if (locked) {
    loading = false;
    return;
  }
  loading = true;
  loadError = '';
  notReady = false;
  try {
    const result =
      folder === 'drafts'
        ? await encryptedDraftList()
        : await listThreads({ folder, limit: 30, q: search.trim() || undefined });
    const reader = new MailReader(address);
    const decrypted = await reader.decryptThreadList(result);
    threads = uniqueBy(decrypted.threads, (t) => t.id);
    counts = decrypted.counts ?? result.counts ?? counts;
    if (folder === 'inbox') unreadTotal = counts.inbox ?? unreadTotal;
    if (result.threads.length > 0 && decrypted.threads.length === 0) {
      loadError = t('mail.key_unavailable') || 'Encrypted mail could not be opened on this device.';
    }
  } catch (error) {
    if (isMailNotImplemented(error)) notReady = true;
    else loadError = t('mail.load_failed') || 'Could not load mail.';
  } finally {
    if (!destroyed) loading = false;
  }
}

async function encryptedDraftList() {
  const result = await listDrafts();
  return {
    threads: result.drafts.map((d) => ({
      id: d.id,
      folder: 'drafts' as const,
      subject: '',
      snippet: '',
      from_name: '',
      from_address: d.from_addr,
      date: d.received_at,
      unread: false,
      starred: false,
      has_attachment: d.has_attachments,
      message_count: 1,
      security: 'e2ee' as const,
      messageId: d.id,
    })),
    counts,
  };
}

function markRead(thread: MailRow): void {
  if (!thread.unread) return;
  thread.unread = false;
  void applyMessageAction('read', [thread.messageId ?? thread.id]).catch(() => undefined);
  unreadTotal = Math.max(0, unreadTotal - 1);
  if (folder === 'inbox') counts = { ...counts, inbox: Math.max(0, unreadTotal) };
}

function toggleStar(thread: MailRow): void {
  thread.starred = !thread.starred;
  void applyMessageAction(thread.starred ? 'star' : 'unstar', [thread.messageId ?? thread.id]).catch(() => undefined);
}

function openThread(thread: MailRow): void {
  if (thread.folder === 'drafts') {
    goToMailCompose(thread.messageId ?? thread.id);
    return;
  }
  markRead(thread);
  goToMailThread(thread.id);
}

onMount(() => {
  void (async () => {
    if (!currentUser) return;
    try {
      address = primaryAddressForUsername(currentUser.username);
    } catch {
      invalidUsername = true;
      return;
    }
    const [addresses, unread] = await Promise.all([
      listAddresses().catch(() => ({ addresses: [] })),
      getMailUnreadCount().catch(() => 0),
    ]);
    if (destroyed) return;
    unreadTotal = unread;
    const mine = addresses.addresses.find((a) => a.address === address);
    active = mine?.state === 'active';
    if (!active) {
      loading = false;
      return;
    }
    await tryDeviceUnlock();
    if (destroyed) return;
    locked = !(await import('../vault/session.ts').then((m) => m.isVaultUnlocked()));
    if (destroyed) return;
    if (locked) {
      loading = false;
      // The unlock host only exists after Svelte renders the locked branch.
      await tick();
      if (destroyed) return;
      if (unlockHost) {
        unlockInstance = mountVaultUnlock(unlockHost, () => {
          if (destroyed) return;
          locked = false;
          void loadThreads();
        });
      }
      return;
    }
    if (!destroyed) await loadThreads();
  })();
});

onDestroy(() => {
  destroyed = true;
  // mountVaultUnlock returns a destroy handle, not a Svelte mount instance.
  unlockInstance?.destroy();
  unlockInstance = null;
});
</script>

<div class="mail-page">
  <div class="mail-top">
    <div class="mail-topbar">
      <div class="mail-titles">
        <h1 class="mail-title">{t('mail.title') || 'Mail'}</h1>
        <span class="mail-address">{address}</span>
      </div>
      <div class="mail-topbar-actions">
        <button class="mail-compose-button" type="button" onclick={() => goToMailCompose()}>
          {@html iconHtml('compose', 16)} {t('mail.compose') || 'Compose'}
        </button>
        <button type="button" class="mail-icon-button" aria-label={t('mail.settings') || 'Mail settings'} onclick={() => goToMailSettings()}>
          {@html iconHtml('settings', 18)}
        </button>
      </div>
    </div>

    {#if currentUser && !invalidUsername}
      <nav class="mail-folder-tabs" aria-label={t('mail.folders') || 'Folders'}>
        {#each FOLDERS as f (f.id)}
          <button
            type="button"
            class="mail-folder-tab"
            class:active={folder === f.id}
            data-folder={f.id}
            onclick={() => { folder = f.id; search = ''; void loadThreads(); }}
          >
            {@html iconHtml(f.icon as never, 15)}
            <span>{t(f.key) || f.id}</span>
            <span class="mail-count" class:mail-count--visible={folderCount(f.id) > 0} data-count={f.id}>
              {folderCount(f.id) > 99 ? '99+' : folderCount(f.id) > 0 ? folderCount(f.id) : ''}
            </span>
          </button>
        {/each}
      </nav>
      <div class="mail-search-row">
        <label class="mail-search">
          {@html iconHtml('search', 15)}
          <input
            type="search"
            placeholder={t('mail.search_placeholder') || 'Search mail'}
            aria-label={t('mail.search_placeholder') || 'Search mail'}
            bind:value={search}
          />
        </label>
      </div>
    {/if}
  </div>

  <div class="mail-list">
    {#if !currentUser}
      <div class="page-empty"><span class="page-empty-icon"></span><p class="page-empty-title fx-display">{t('mail.requires_login') || 'Sign in to use Mail.'}</p></div>
    {:else if invalidUsername}
      <div class="page-empty"><span class="page-empty-icon"></span><p class="page-empty-title fx-display">{t('mail.invalid_username') || 'Your username cannot be a Mail address.'}</p></div>
    {:else if !active}
      <div class="page-empty"><span class="page-empty-icon"></span><p class="page-empty-title fx-display">{t('mail.not_activated') || 'Mail is not activated yet.'}</p><p>{t('mail.activate_hint') || ''}</p><button type="button" class="mail-button mail-button--primary" onclick={() => goToMailSettings()}>{t('mail.open_settings') || 'Open Mail settings'}</button></div>
    {:else if locked}
      <div class="page-empty"><span class="page-empty-icon"></span><p class="page-empty-title fx-display">{t('mail.unlock_to_read') || 'Unlock to read mail'}</p><div bind:this={unlockHost}></div></div>
    {:else if loading}
      {#each [0, 1, 2, 3, 4] as i (i)}
        <div class="mail-skeleton-row"><span class="mail-skeleton-avatar"></span><span class="mail-skeleton-body"><span class="mail-skeleton-line" style="width:45%"></span><span class="mail-skeleton-line" style="width:78%"></span><span class="mail-skeleton-line" style="width:58%"></span></span></div>
      {/each}
    {:else if loadError}
      <div class="page-empty"><span class="page-empty-icon"></span><p class="page-empty-title fx-display">{t('mail.load_failed_title') || 'Could not load mail'}</p><p>{loadError}</p><button type="button" onclick={() => void loadThreads()}>{t('common.retry') || 'Retry'}</button></div>
    {:else if notReady}
      <div class="page-empty"><span class="page-empty-icon"></span><p class="page-empty-title fx-display">{t('mail.not_ready_title') || 'Mailbox is getting ready'}</p><p>{t('mail.not_ready_desc') || ''}</p></div>
    {:else if visible.length === 0}
      <div class="page-empty"><span class="page-empty-icon"></span><p class="page-empty-title fx-display">{search ? (t('mail.search_empty_title') || 'No matching messages') : folder === 'inbox' ? (t('mail.empty_inbox_title') || 'Your inbox is quiet') : `${t(folder === 'drafts' ? 'mail.folder_drafts' : 'mail.folder_sent')} · ${t('mail.empty_title') || 'Nothing here'}`}</p><p>{search ? (t('mail.search_empty_desc') || '') : t('mail.empty_desc') || ''}</p></div>
    {:else}
      <div class="mail-thread-list" role="list">
        {#each visible as thread (thread.id)}
          <div
            class="mail-thread-row"
            class:mail-thread-row--unread={thread.unread}
            data-thread-id={thread.id}
            role="listitem"
            tabindex="0"
            onclick={() => openThread(thread)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openThread(thread); } }}
          >
            <span class="mail-avatar">{(thread.from_name || thread.from_address || '?').charAt(0).toUpperCase()}</span>
            <div class="mail-thread-main">
              <div class="mail-thread-head">
                <span class="mail-thread-sender">{thread.from_name || thread.from_address}</span>
                <time class="mail-thread-date" datetime={thread.date}>{formatMailDate(thread.date)}</time>
              </div>
              <span class="mail-thread-subject">{thread.subject || t('mail.no_subject') || '(No subject)'} {#if thread.has_attachment}{@html iconHtml('paperclip', 12)}{/if}</span>
              <span class="mail-thread-snippet">{thread.snippet}</span>
            </div>
            <div class="mail-thread-side">
              {#if thread.unread}<span class="mail-unread-dot" aria-label={t('mail.unread') || 'Unread'}></span>{/if}
              <button
                type="button"
                class="mail-row-action mail-star"
                class:mail-star--active={thread.starred}
                aria-label={thread.starred ? (t('mail.unstar') || 'Unstar') : (t('mail.star') || 'Star')}
                onclick={(e) => { e.stopPropagation(); toggleStar(thread); }}
              >{@html iconHtml('star', 16)}</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
