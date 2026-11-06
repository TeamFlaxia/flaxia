// Mailbox shell (docs/mail.md §10). P1: activation + quota skeleton.
// Thread list/detail, compose, labels, search land in P2-P4.
import { t } from '../lib/i18n.js';
import { primaryAddressForUsername } from '../lib/mail/address.js';
import { getQuota, listAddresses } from '../lib/mail/api.js';
import { ensureVaultUnlocked, provisionMailIdentity } from '../lib/vault/mail-identity.js';
import { isVaultUnlocked } from '../lib/vault/session.js';

export interface MailPageProps {
  currentUser: { id: string; username: string } | null;
}

export class MailPage {
  private element: HTMLElement;

  constructor(props: MailPageProps) {
    this.element = document.createElement('div');
    this.element.className = 'mail-page';
    void this.render(props);
  }

  private async render(props: MailPageProps): Promise<void> {
    const el = this.element;
    el.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'mail-header';
    const title = document.createElement('h2');
    title.textContent = t('mail.title') || 'Mail';
    header.appendChild(title);
    el.appendChild(header);

    const status = document.createElement('p');
    status.className = 'mail-status';
    status.textContent = t('mail.loading') || 'Loading…';
    el.appendChild(status);

    if (!props.currentUser) {
      status.textContent = t('mail.requires_login') || 'Sign in to use Mail.';
      return;
    }

    let expectedAddress = '';
    try {
      expectedAddress = primaryAddressForUsername(props.currentUser.username);
    } catch {
      status.textContent = t('mail.invalid_username') || 'Your username cannot be a Mail address.';
      return;
    }

    const { addresses } = await listAddresses().catch(() => ({ addresses: [] as never[] }));
    const mine = (addresses as Array<{ address: string; state: string }>).find((a) => a.address === expectedAddress);
    if (!mine || mine.state !== 'active') {
      status.textContent = t('mail.not_activated') || 'Mail is not activated yet.';
      const hint = document.createElement('p');
      hint.className = 'mail-hint';
      hint.textContent =
        t('mail.activate_hint') || 'Activate your address in Mail settings. A Personal Vault is required.';
      el.appendChild(hint);
      const cta = document.createElement('a');
      cta.href = '/mail/settings';
      cta.textContent = t('mail.open_settings') || 'Open Mail settings';
      cta.className = 'mail-cta';
      el.appendChild(cta);
      return;
    }

    const quota = await getQuota().catch(() => null);
    const quotaEl = document.createElement('p');
    quotaEl.className = 'mail-quota';
    const usedMiB = quota ? Math.round(quota.storage_bytes / 1024 / 1024) : 0;
    quotaEl.textContent = quota
      ? (t('mail.quota') || 'Storage').replace('{used}', String(usedMiB)).replace('{total}', '512')
      : '';
    el.appendChild(quotaEl);

    const folders = document.createElement('nav');
    folders.className = 'mail-folders';
    const labels = [
      ['inbox', t('mail.folder_inbox') || 'Inbox'],
      ['sent', t('mail.folder_sent') || 'Sent'],
      ['drafts', t('mail.folder_drafts') || 'Drafts'],
      ['archive', t('mail.folder_archive') || 'Archive'],
      ['spam', t('mail.folder_spam') || 'Spam'],
      ['trash', t('mail.folder_trash') || 'Trash'],
    ];
    for (const [id, label] of labels) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mail-folder';
      b.dataset.folder = id;
      b.textContent = label;
      folders.appendChild(b);
    }
    el.appendChild(folders);

    const list = document.createElement('div');
    list.className = 'mail-thread-list';
    const empty = document.createElement('p');
    empty.textContent = t('mail.no_threads_yet') || 'No messages yet. Thread list lands in P2.';
    list.appendChild(empty);
    el.appendChild(list);

    status.remove();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
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
