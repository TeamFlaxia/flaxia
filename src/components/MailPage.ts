// Flaxia Mail mailbox (docs/mail.md §10). P1 activates the address; the list
// and reading surfaces consume the P2 API and fail gracefully while it is 501.
import { t } from '../lib/i18n.js';
import { icon } from '../lib/icons.js';
import { primaryAddressForUsername } from '../lib/mail/address.js';
import {
  applyMessageAction,
  type EncryptedThreadList,
  getMailUnreadCount,
  isMailNotImplemented,
  listAddresses,
  listDrafts,
  listThreads,
  type MailFolder,
  type MailThreadSummary,
} from '../lib/mail/api.js';
import { goToMailCompose, goToMailSettings, goToMailThread } from '../lib/mail/navigation.js';
import { MailReader } from '../lib/mail/reader.js';
import { avatar, emptyState, formatMailDate, iconButton, mailButton, triggerPop } from '../lib/mail/ui.js';
import { ensureVaultUnlocked, provisionMailIdentity } from '../lib/vault/mail-identity.js';
import { isVaultUnlocked, tryDeviceUnlock } from '../lib/vault/session.js';
import { createVaultUnlockForm } from './VaultUnlockForm.js';

export interface MailPageProps {
  currentUser: { id: string; username: string } | null;
}

type MailRow = MailThreadSummary & { messageId?: string };

interface FolderDef {
  id: MailFolder;
  label: string;
  icon: 'inbox' | 'send' | 'drafts' | 'archive' | 'warning' | 'trash';
}

const FOLDERS: FolderDef[] = [
  { id: 'inbox', label: t('mail.folder_inbox') || 'Inbox', icon: 'inbox' },
  { id: 'sent', label: t('mail.folder_sent') || 'Sent', icon: 'send' },
  { id: 'drafts', label: t('mail.folder_drafts') || 'Drafts', icon: 'drafts' },
  { id: 'archive', label: t('mail.folder_archive') || 'Archive', icon: 'archive' },
  { id: 'spam', label: t('mail.folder_spam') || 'Spam', icon: 'warning' },
  { id: 'trash', label: t('mail.folder_trash') || 'Trash', icon: 'trash' },
];

export class MailPage {
  private element: HTMLElement;
  private props: MailPageProps;
  private folder: MailFolder = 'inbox';
  private threads: MailRow[] = [];
  private counts: Partial<Record<MailFolder, number>> = {};
  private loading = true;
  private notReady = false;
  private loadError: string | null = null;
  private search = '';
  private address = '';
  private active = false;
  private locked = false;
  private unreadTotal = 0;
  private destroyed = false;
  private listEl: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;

  constructor(props: MailPageProps) {
    this.props = props;
    this.element = document.createElement('div');
    this.element.className = 'mail-page';
    void this.init();
  }

  private async init(): Promise<void> {
    if (!this.props.currentUser) {
      this.renderShell({ login: true });
      this.renderList();
      return;
    }

    try {
      this.address = primaryAddressForUsername(this.props.currentUser.username);
    } catch {
      this.renderMessage('mail.invalid_username', 'Your username cannot be a Mail address.', 'warning');
      return;
    }

    const addressesPromise = listAddresses().catch(() => ({ addresses: [] }));
    const unreadPromise = getMailUnreadCount().catch(() => 0);
    const [addresses, unread] = await Promise.all([addressesPromise, unreadPromise]);
    const mine = addresses.addresses.find((entry) => entry.address === this.address);
    this.active = mine?.state === 'active';
    this.unreadTotal = unread;
    this.renderShell();
    if (!this.active) {
      this.loading = false;
      this.renderList();
      return;
    }
    if (!isVaultUnlocked()) await tryDeviceUnlock();
    this.locked = !isVaultUnlocked();
    if (this.locked) {
      this.loading = false;
      this.renderList();
      return;
    }
    await this.loadThreads();
  }

  private renderMessage(titleKey: string, fallback: string, iconName: 'mail' | 'warning'): void {
    this.element.replaceChildren();
    const top = document.createElement('div');
    top.className = 'mail-top';
    top.appendChild(this.buildTopbar());
    this.element.appendChild(top);
    const list = document.createElement('div');
    list.className = 'mail-list';
    list.appendChild(emptyState(iconName, t(titleKey) || fallback, ''));
    this.element.appendChild(list);
  }

  private buildTopbar(titleKey = 'mail.title', fallback = 'Mail'): HTMLElement {
    const header = document.createElement('div');
    header.className = 'mail-topbar';

    const titles = document.createElement('div');
    titles.className = 'mail-titles';
    const title = document.createElement('h1');
    title.className = 'mail-title';
    title.textContent = t(titleKey) || fallback;
    const address = document.createElement('span');
    address.className = 'mail-address';
    address.textContent = this.address;
    titles.appendChild(title);
    titles.appendChild(address);
    header.appendChild(titles);

    const actions = document.createElement('div');
    actions.className = 'mail-topbar-actions';
    const compose = mailButton(t('mail.compose') || 'Compose', 'primary', 'compose');
    compose.classList.add('mail-compose-button');
    compose.addEventListener('click', () => goToMailCompose());
    actions.appendChild(compose);
    actions.appendChild(iconButton('settings', t('mail.settings') || 'Mail settings', goToMailSettings));
    header.appendChild(actions);
    return header;
  }

  private renderShell(options: { login?: boolean } = {}): void {
    this.element.replaceChildren();
    const top = document.createElement('div');
    top.className = 'mail-top';
    top.appendChild(this.buildTopbar());
    if (!options.login) {
      this.tabsEl = this.buildTabs();
      top.appendChild(this.tabsEl);
      top.appendChild(this.buildSearch());
    }
    this.element.appendChild(top);

    this.listEl = document.createElement('div');
    this.listEl.className = 'mail-list';
    this.listEl.setAttribute('role', 'list');
    this.element.appendChild(this.listEl);
  }

  private buildTabs(): HTMLElement {
    const tabs = document.createElement('nav');
    tabs.className = 'mail-folder-tabs';
    tabs.setAttribute('aria-label', t('mail.folders') || 'Folders');
    for (const folder of FOLDERS) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'mail-folder-tab';
      tab.dataset.folder = folder.id;
      tab.addEventListener('click', () => {
        if (this.folder === folder.id) return;
        this.folder = folder.id;
        this.search = '';
        if (this.searchInput) this.searchInput.value = '';
        this.updateTabs();
        void this.loadThreads();
      });
      tab.appendChild(icon(folder.icon, { width: '15', height: '15' }));
      const label = document.createElement('span');
      label.textContent = folder.label;
      tab.appendChild(label);
      const count = document.createElement('span');
      count.className = 'mail-count';
      count.dataset.count = folder.id;
      tab.appendChild(count);
      tabs.appendChild(tab);
    }
    queueMicrotask(() => this.updateTabs());
    return tabs;
  }

  private updateTabs(): void {
    if (!this.tabsEl) return;
    for (const tab of this.tabsEl.querySelectorAll<HTMLButtonElement>('.mail-folder-tab')) {
      const id = tab.dataset.folder as MailFolder | undefined;
      if (!id) continue;
      tab.classList.toggle('active', id === this.folder);
      const count = tab.querySelector<HTMLElement>('.mail-count');
      if (!count) continue;
      const value = this.counts[id] ?? (id === 'inbox' ? this.unreadTotal : 0);
      count.textContent = value > 0 ? String(value > 99 ? '99+' : value) : '';
      count.classList.toggle('mail-count--visible', value > 0);
    }
  }

  private buildSearch(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mail-search-row';
    const wrapper = document.createElement('label');
    wrapper.className = 'mail-search';
    wrapper.appendChild(icon('search', { width: '15', height: '15' }));
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = t('mail.search_placeholder') || 'Search mail';
    input.setAttribute('aria-label', t('mail.search_placeholder') || 'Search mail');
    input.value = this.search;
    input.addEventListener('input', () => {
      this.search = input.value;
      this.renderList();
    });
    this.searchInput = input;
    wrapper.appendChild(input);
    row.appendChild(wrapper);
    return row;
  }

  private async loadThreads(): Promise<void> {
    if (this.destroyed) return;
    if (this.locked) {
      this.loading = false;
      this.renderList();
      return;
    }
    this.loading = true;
    this.loadError = null;
    this.notReady = false;
    this.renderList();
    try {
      const result: EncryptedThreadList =
        this.folder === 'drafts'
          ? await this.encryptedDraftList()
          : await listThreads({
              folder: this.folder,
              limit: 30,
              q: this.search.trim() || undefined,
            });
      const reader = new MailReader(this.address);
      const decrypted = await reader.decryptThreadList(result);
      this.threads = decrypted.threads;
      this.counts = decrypted.counts ?? result.counts ?? this.counts;
      if (this.folder === 'inbox') this.unreadTotal = this.counts.inbox ?? this.unreadTotal;
      if (result.threads.length > 0 && decrypted.threads.length === 0) {
        this.loadError =
          t('mail.key_unavailable') ||
          'Encrypted mail could not be opened on this device. Unlock the vault and try again.';
      }
    } catch (error) {
      if (isMailNotImplemented(error)) this.notReady = true;
      else this.loadError = t('mail.load_failed') || 'Could not load mail. Check your connection and try again.';
    } finally {
      this.loading = false;
      if (!this.destroyed) {
        this.updateTabs();
        this.renderList();
      }
    }
  }

  private async encryptedDraftList(): Promise<EncryptedThreadList> {
    const result = await listDrafts();
    return {
      threads: result.drafts.map((draft) => ({
        id: draft.id,
        folder: 'drafts' as const,
        last_message_at: draft.received_at,
        message_count: 1,
        unread_count: 0,
        message_id: draft.id,
        subject_enc: draft.subject_enc,
        meta_enc: draft.meta_enc,
        payload_iv: draft.payload_iv,
        blob_id: '',
        aad_id: draft.aad_id,
        from_addr: draft.from_addr,
        received_at: draft.received_at,
        read_at: draft.received_at,
        starred_at: null,
        has_attachments: draft.has_attachments,
        size_bytes: draft.size_bytes,
        security: 'e2ee' as const,
        key: draft.key,
      })),
      counts: this.counts,
    };
  }

  private filteredThreads(): MailRow[] {
    const query = this.search.trim().toLowerCase();
    return this.threads
      .filter((thread) => !thread.folder || thread.folder === this.folder)
      .filter((thread) => {
        if (!query) return true;
        return `${thread.subject} ${thread.from_name} ${thread.from_address} ${thread.snippet}`
          .toLowerCase()
          .includes(query);
      });
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.replaceChildren();

    if (!this.props.currentUser) {
      list.appendChild(emptyState('mail', t('mail.requires_login') || 'Sign in to use Mail.', ''));
      return;
    }

    if (!this.active) {
      const empty = emptyState(
        'mail-open',
        t('mail.not_activated') || 'Mail is not activated yet.',
        t('mail.activate_hint') || 'Activate your address in Mail settings. A Personal Vault is required.',
      );
      const action = mailButton(t('mail.open_settings') || 'Open Mail settings', 'primary', 'settings');
      action.addEventListener('click', () => goToMailSettings());
      empty.appendChild(action);
      list.appendChild(empty);
      return;
    }

    if (this.locked) {
      const empty = emptyState(
        'lock',
        t('mail.unlock_to_read') || 'Unlock to read mail',
        t('mail.unlock_to_read_desc') ||
          'Your messages are encrypted with the Personal Vault. Unlock it on this device to decrypt the mailbox.',
      );
      empty.appendChild(
        createVaultUnlockForm({
          onUnlocked: () => {
            this.locked = false;
            void this.loadThreads();
          },
        }).getElement(),
      );
      list.appendChild(empty);
      return;
    }

    if (this.loading) {
      for (let index = 0; index < 5; index += 1) {
        const skeleton = document.createElement('div');
        skeleton.className = 'mail-skeleton-row';
        const avatarNode = document.createElement('span');
        avatarNode.className = 'mail-skeleton-avatar';
        const body = document.createElement('span');
        body.className = 'mail-skeleton-body';
        for (const width of ['45%', '78%', '58%']) {
          const line = document.createElement('span');
          line.className = 'mail-skeleton-line';
          line.style.width = width;
          body.appendChild(line);
        }
        skeleton.appendChild(avatarNode);
        skeleton.appendChild(body);
        list.appendChild(skeleton);
      }
      return;
    }

    if (this.loadError) {
      const empty = emptyState('warning', t('mail.load_failed_title') || 'Could not load mail', this.loadError);
      const retry = mailButton(t('common.retry') || 'Retry', 'secondary', 'refresh');
      retry.addEventListener('click', () => void this.loadThreads());
      empty.appendChild(retry);
      list.appendChild(empty);
      return;
    }

    if (this.notReady) {
      list.appendChild(
        emptyState(
          'mail-open',
          t('mail.not_ready_title') || 'Mailbox is getting ready',
          t('mail.not_ready_desc') ||
            'Receiving and reading mail arrives in the next Mail release. Your address and encryption keys are ready.',
        ),
      );
      return;
    }

    const threads = this.filteredThreads();
    if (threads.length === 0) {
      const empty = emptyState(
        'inbox',
        this.search
          ? t('mail.search_empty_title') || 'No matching messages'
          : this.folder === 'inbox'
            ? t('mail.empty_inbox_title') || 'Your inbox is quiet'
            : `${FOLDERS.find((entry) => entry.id === this.folder)?.label ?? ''} · ${t('mail.empty_title') || 'Nothing here'}`,
        this.search
          ? t('mail.search_empty_desc') || 'Try a different sender, subject, or word.'
          : this.folder === 'inbox'
            ? t('mail.empty_inbox_desc') ||
              'New mail will appear here. Compose a message or wait for your first delivery.'
            : t('mail.empty_desc') || 'There are no messages in this folder.',
      );
      if (this.folder === 'inbox' && !this.search) {
        const compose = mailButton(t('mail.compose') || 'Compose', 'primary', 'compose');
        compose.addEventListener('click', () => goToMailCompose());
        empty.appendChild(compose);
      }
      list.appendChild(empty);
      return;
    }

    for (const thread of threads) {
      list.appendChild(this.buildRow(thread));
    }
  }

  private buildRow(thread: MailRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mail-thread-row';
    row.setAttribute('role', 'listitem');
    row.tabIndex = 0;
    row.classList.toggle('mail-thread-row--unread', thread.unread);
    const open = (): void => {
      if (thread.folder === 'drafts') {
        goToMailCompose(thread.messageId ?? thread.id);
        return;
      }
      this.markRead(thread);
      goToMailThread(thread.id);
    };
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.mail-row-action')) return;
      open();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    row.appendChild(avatar(thread.from_name || thread.from_address));

    const main = document.createElement('div');
    main.className = 'mail-thread-main';
    const head = document.createElement('div');
    head.className = 'mail-thread-head';
    const sender = document.createElement('span');
    sender.className = 'mail-thread-sender';
    sender.textContent = thread.from_name || thread.from_address;
    const date = document.createElement('time');
    date.className = 'mail-thread-date';
    date.dateTime = thread.date;
    date.textContent = formatMailDate(thread.date);
    head.appendChild(sender);
    head.appendChild(date);
    const subject = document.createElement('span');
    subject.className = 'mail-thread-subject';
    subject.textContent = thread.subject || t('mail.no_subject') || '(No subject)';
    if (thread.has_attachment) {
      const clip = icon('paperclip', { width: '12', height: '12' });
      clip.classList.add('mail-thread-clip');
      subject.appendChild(clip);
    }
    const snippet = document.createElement('span');
    snippet.className = 'mail-thread-snippet';
    snippet.textContent = thread.snippet;
    main.appendChild(head);
    main.appendChild(subject);
    main.appendChild(snippet);
    row.appendChild(main);

    const side = document.createElement('div');
    side.className = 'mail-thread-side';
    if (thread.unread) {
      const dot = document.createElement('span');
      dot.className = 'mail-unread-dot';
      dot.setAttribute('aria-label', t('mail.unread') || 'Unread');
      side.appendChild(dot);
    }
    const star = iconButton('star', thread.starred ? t('mail.unstar') || 'Unstar' : t('mail.star') || 'Star', () =>
      this.toggleStar(thread, star),
    );
    star.classList.add('mail-row-action', 'mail-star');
    star.classList.toggle('mail-star--active', thread.starred);
    side.appendChild(star);
    row.appendChild(side);

    return row;
  }

  private markRead(thread: MailRow): void {
    if (!thread.unread) return;
    thread.unread = false;
    void applyMessageAction('read', [thread.messageId ?? thread.id]).catch(() => undefined);
    this.unreadTotal = Math.max(0, this.unreadTotal - 1);
    if (this.folder === 'inbox') this.counts = { ...this.counts, inbox: Math.max(0, (this.counts.inbox ?? 0) - 1) };
    this.updateTabs();
    this.renderList();
  }

  private toggleStar(thread: MailRow, starButton?: HTMLButtonElement): void {
    thread.starred = !thread.starred;
    void applyMessageAction(thread.starred ? 'star' : 'unstar', [thread.messageId ?? thread.id]).catch(() => undefined);
    // Update in place so the row does not replay its entrance on every
    // toggle; the pop reports the state change (motion.css "press and
    // answer") instead of a silent swap.
    if (starButton) {
      const label = thread.starred ? t('mail.unstar') || 'Unstar' : t('mail.star') || 'Star';
      starButton.classList.toggle('mail-star--active', thread.starred);
      starButton.setAttribute('aria-label', label);
      starButton.setAttribute('aria-pressed', String(thread.starred));
      starButton.title = label;
      triggerPop(starButton);
    } else {
      this.renderList();
    }
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    this.destroyed = true;
    this.element.remove();
  }
}

export function createMailPage(props: MailPageProps): MailPage {
  return new MailPage(props);
}

export async function activateMailAddress(username: string): Promise<string> {
  const unlocked = await ensureVaultUnlocked();
  if (!unlocked || !isVaultUnlocked()) throw new Error('mail_vault_required');
  const identity = await provisionMailIdentity(1);
  const { activateAddress } = await import('../lib/mail/api.js');
  await activateAddress({ publicKey: identity.publicKeySpkiB64, keyVersion: 1, vaultUnlocked: true });
  return primaryAddressForUsername(username);
}
