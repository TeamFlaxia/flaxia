// Mail settings: address, quota, Vault status (docs/mail.md §10, §11.2).
import { t } from '../lib/i18n.js';
import { primaryAddressForUsername } from '../lib/mail/address.js';
import { getQuota } from '../lib/mail/api.js';
import { isVaultUnlocked } from '../lib/vault/session.js';
import { activateMailAddress } from './MailPage.js';

export interface MailSettingsPageProps {
  currentUser: { id: string; username: string } | null;
}

export class MailSettingsPage {
  private element: HTMLElement;

  constructor(props: MailSettingsPageProps) {
    this.element = document.createElement('div');
    this.element.className = 'mail-settings';
    void this.render(props);
  }

  private async render(props: MailSettingsPageProps): Promise<void> {
    const el = this.element;
    el.innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = t('mail.settings_title') || 'Mail settings';
    el.appendChild(h);

    if (!props.currentUser) {
      const p = document.createElement('p');
      p.textContent = t('mail.requires_login') || 'Sign in to use Mail.';
      el.appendChild(p);
      return;
    }

    const addr = document.createElement('p');
    try {
      addr.textContent = `${t('mail.address') || 'Address'}: ${primaryAddressForUsername(props.currentUser.username)}`;
    } catch {
      addr.textContent = t('mail.invalid_username') || 'Your username cannot be a Mail address.';
    }
    el.appendChild(addr);

    const vault = document.createElement('p');
    vault.textContent = isVaultUnlocked()
      ? t('mail.vault_unlocked') || 'Personal Vault: unlocked'
      : t('mail.vault_locked') || 'Personal Vault: locked (unlock in Settings to activate Mail)';
    el.appendChild(vault);

    const activate = document.createElement('button');
    activate.type = 'button';
    activate.textContent = t('mail.activate') || 'Activate Mail address';
    const msg = document.createElement('p');
    activate.addEventListener('click', () => {
      void (async () => {
        if (!props.currentUser) return;
        msg.textContent = '';
        try {
          const address = await activateMailAddress(props.currentUser.username);
          msg.textContent = address;
        } catch (e) {
          msg.textContent = (e as Error).message;
        }
      })();
    });
    el.appendChild(activate);
    el.appendChild(msg);

    const quota = await getQuota().catch(() => null);
    if (quota) {
      const q = document.createElement('p');
      const usedMiB = Math.round(quota.storage_bytes / 1024 / 1024);
      q.textContent = `${t('mail.quota') || 'Storage'}: ${usedMiB} MiB / 512 MiB · ${quota.external_sends}/${quota.daily_external_limit}`;
      el.appendChild(q);
    }
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    this.element.remove();
  }
}

export function createMailSettingsPage(props: MailSettingsPageProps): MailSettingsPage {
  return new MailSettingsPage(props);
}
