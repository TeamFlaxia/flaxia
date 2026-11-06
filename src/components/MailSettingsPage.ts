// Mail settings: address, quota, Vault status (docs/mail.md §10, §11.2).
import { t } from '../lib/i18n.js';
import { primaryAddressForUsername } from '../lib/mail/address.js';
import { getQuota } from '../lib/mail/api.js';
import { isVaultUnlocked } from '../lib/vault/session.js';
import { activateMailAddress } from './MailPage.js';
import { createVaultUnlockForm, type VaultUnlockForm } from './VaultUnlockForm.js';

export interface MailSettingsPageProps {
  currentUser: { id: string; username: string } | null;
}

export class MailSettingsPage {
  private element: HTMLElement;
  private unlockForm: VaultUnlockForm | null = null;

  constructor(props: MailSettingsPageProps) {
    this.element = document.createElement('div');
    this.element.className = 'mail-settings';
    void this.render(props);
  }

  private async render(props: MailSettingsPageProps): Promise<void> {
    const el = this.element;
    this.unlockForm?.destroy();
    this.unlockForm = null;
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

    const unlocked = isVaultUnlocked();
    const vault = document.createElement('p');
    vault.textContent = unlocked
      ? t('mail.vault_unlocked') || 'Personal Vault: unlocked'
      : t('mail.vault_locked') || 'Personal Vault: locked (unlock below to activate Mail)';
    el.appendChild(vault);

    if (!unlocked) {
      // Keep the unlock flow in this page: reloading or opening Mail settings
      // directly should not require a detour through Settings. The form tries
      // the remembered device key first, then offers the password prompt.
      this.unlockForm = createVaultUnlockForm({
        onUnlocked: () => {
          void this.render(props);
        },
      });
      el.appendChild(this.unlockForm.getElement());
    }

    const activate = document.createElement('button');
    activate.type = 'button';
    activate.textContent = t('mail.activate') || 'Activate Mail address';
    activate.disabled = !unlocked;
    const msg = document.createElement('p');
    activate.addEventListener('click', () => {
      void (async () => {
        if (!props.currentUser) return;
        msg.textContent = '';
        try {
          const address = await activateMailAddress(props.currentUser.username);
          msg.textContent = address;
        } catch (e) {
          const code = (e as Error).message;
          if (code.includes('mail_vault_required')) {
            // The vault locked underneath us (for example after a manual lock
            // in another tab): show the unlock form instead of a raw error.
            void this.render(props);
            return;
          }
          msg.textContent = code;
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
    this.unlockForm?.destroy();
    this.unlockForm = null;
    this.element.remove();
  }
}

export function createMailSettingsPage(props: MailSettingsPageProps): MailSettingsPage {
  return new MailSettingsPage(props);
}
