// Mail settings (docs/mail.md §10, §11.2). Mailbox activation, quota and the
// encryption boundary live here; the compact vault unlock form is shared with
// the mailbox so a reload never forces a detour through Settings.
import { t } from '../lib/i18n.js';
import { icon } from '../lib/icons.js';
import { primaryAddressForUsername } from '../lib/mail/address.js';
import { getQuota, listAddresses } from '../lib/mail/api.js';
import { isMailPreview } from '../lib/mail/demo.js';
import { goToMail, mailBack } from '../lib/mail/navigation.js';
import { mailButton } from '../lib/mail/ui.js';
import { isVaultUnlocked } from '../lib/vault/session.js';
import { activateMailAddress } from './MailPage.js';
import { createVaultUnlockForm, type VaultUnlockForm } from './VaultUnlockForm.js';

export interface MailSettingsPageProps {
  currentUser: { id: string; username: string } | null;
}

export class MailSettingsPage {
  private element: HTMLElement;
  private unlockForm: VaultUnlockForm | null = null;
  private props: MailSettingsPageProps;

  constructor(props: MailSettingsPageProps) {
    this.props = props;
    this.element = document.createElement('div');
    this.element.className = 'mail-settings-page';
    void this.render();
  }

  private async render(): Promise<void> {
    const el = this.element;
    this.unlockForm?.destroy();
    this.unlockForm = null;
    el.replaceChildren();

    const header = document.createElement('header');
    header.className = 'page-header mail-settings-header';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'page-header-back';
    back.setAttribute('aria-label', t('mail.back') || 'Back to Mail');
    back.appendChild(icon('arrow-left', { width: '17', height: '17' }));
    back.addEventListener('click', () => mailBack());
    header.appendChild(back);
    const titles = document.createElement('div');
    titles.className = 'page-header-titles';
    const title = document.createElement('h1');
    title.className = 'page-header-title';
    title.textContent = t('mail.settings_title') || 'Mail settings';
    const subtitle = document.createElement('span');
    subtitle.className = 'page-header-subtitle';
    subtitle.textContent = t('mail.settings_subtitle') || 'Address, storage and encryption';
    titles.appendChild(title);
    titles.appendChild(subtitle);
    header.appendChild(titles);
    el.appendChild(header);

    const content = document.createElement('div');
    content.className = 'mail-settings-content';
    el.appendChild(content);

    if (!this.props.currentUser) {
      const msg = document.createElement('p');
      msg.className = 'mail-settings-muted';
      msg.textContent = t('mail.requires_login') || 'Sign in to use Mail.';
      content.appendChild(msg);
      return;
    }

    let expectedAddress = '';
    try {
      expectedAddress = primaryAddressForUsername(this.props.currentUser.username);
    } catch {
      const msg = document.createElement('p');
      msg.className = 'mail-settings-muted';
      msg.textContent = t('mail.invalid_username') || 'Your username cannot be a Mail address.';
      content.appendChild(msg);
      return;
    }

    const preview = isMailPreview();
    const [addresses, quota] = await Promise.all([
      preview ? Promise.resolve({ addresses: [] }) : listAddresses().catch(() => ({ addresses: [] })),
      getQuota().catch(() => null),
    ]);
    const mine = addresses.addresses.find((entry) => entry.address === expectedAddress);
    const active = preview || mine?.state === 'active';

    content.appendChild(this.buildMailboxSection(expectedAddress, active, preview));
    content.appendChild(this.buildStorageSection(quota));
    content.appendChild(this.buildSecuritySection());
  }

  private buildMailboxSection(address: string, active: boolean, preview: boolean): HTMLElement {
    const section = document.createElement('section');
    section.className = 'mail-settings-card';
    const heading = document.createElement('div');
    heading.className = 'mail-settings-card-head';
    const h2 = document.createElement('h2');
    h2.textContent = t('mail.settings_mailbox') || 'Mailbox';
    heading.appendChild(h2);
    const pill = document.createElement('span');
    pill.className = `mail-status-pill mail-status-pill--${active ? 'active' : 'idle'}`;
    pill.textContent = preview
      ? t('mail.preview_badge') || 'Preview'
      : active
        ? t('mail.status_active') || 'Active'
        : t('mail.status_inactive') || 'Not activated';
    heading.appendChild(pill);
    section.appendChild(heading);

    const row = document.createElement('div');
    row.className = 'mail-settings-address-row';
    const avatar = document.createElement('span');
    avatar.className = 'mail-avatar';
    avatar.textContent = address.slice(0, 1).toUpperCase();
    const identity = document.createElement('div');
    identity.className = 'mail-settings-identity';
    const addressEl = document.createElement('span');
    addressEl.className = 'mail-settings-address';
    addressEl.textContent = address;
    const note = document.createElement('span');
    note.className = 'mail-settings-note';
    note.textContent = preview
      ? t('mail.preview_note') || 'Sample mailbox for the UI preview.'
      : active
        ? t('mail.address_active_note') || 'Incoming mail is encrypted in this mailbox.'
        : t('mail.address_inactive_note') || 'Activate to receive mail at this address.';
    identity.appendChild(addressEl);
    identity.appendChild(note);
    row.appendChild(avatar);
    row.appendChild(identity);
    section.appendChild(row);

    if (!active && !preview) {
      const vault = document.createElement('div');
      vault.className = 'mail-settings-vault';
      const lock = document.createElement('div');
      lock.className = 'mail-settings-vault-status';
      lock.appendChild(icon(isVaultUnlocked() ? 'shield' : 'lock', { width: '16', height: '16' }));
      const text = document.createElement('span');
      text.textContent = isVaultUnlocked()
        ? t('mail.vault_unlocked') || 'Personal Vault: unlocked'
        : t('mail.vault_locked') || 'Personal Vault: locked (unlock below to activate Mail)';
      lock.appendChild(text);
      vault.appendChild(lock);
      section.appendChild(vault);

      if (!isVaultUnlocked()) {
        this.unlockForm = createVaultUnlockForm({
          onUnlocked: () => {
            void this.render();
          },
        });
        section.appendChild(this.unlockForm.getElement());
      }

      const activate = mailButton(t('mail.activate') || 'Activate Mail address', 'primary', 'check');
      activate.disabled = !isVaultUnlocked();
      const msg = document.createElement('p');
      msg.className = 'mail-settings-message';
      activate.addEventListener('click', () => {
        void (async () => {
          if (!this.props.currentUser) return;
          msg.textContent = '';
          try {
            await activateMailAddress(this.props.currentUser.username);
            await this.render();
          } catch (error) {
            const code = (error as Error).message;
            if (code.includes('mail_vault_required')) {
              void this.render();
              return;
            }
            msg.textContent = code;
          }
        })();
      });
      section.appendChild(activate);
      section.appendChild(msg);
    } else {
      const open = mailButton(t('mail.open_mail') || 'Open Mail', 'secondary', 'mail');
      open.addEventListener('click', () => goToMail());
      section.appendChild(open);
    }

    return section;
  }

  private buildStorageSection(quota: Awaited<ReturnType<typeof getQuota>> | null): HTMLElement {
    const section = document.createElement('section');
    section.className = 'mail-settings-card';
    const h2 = document.createElement('h2');
    h2.textContent = t('mail.settings_storage') || 'Storage';
    section.appendChild(h2);

    if (!quota) {
      const p = document.createElement('p');
      p.className = 'mail-settings-muted';
      p.textContent = t('mail.quota_unavailable') || 'Storage usage is unavailable right now.';
      section.appendChild(p);
      return section;
    }

    const used = Math.max(0, quota.storage_bytes);
    const total = Math.max(1, quota.storage_quota_bytes);
    const percent = Math.min(100, (used / total) * 100);
    const bar = document.createElement('div');
    bar.className = 'mail-quota-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(Math.round(percent)));
    const fill = document.createElement('span');
    fill.style.width = `${percent}%`;
    bar.appendChild(fill);
    section.appendChild(bar);

    const meta = document.createElement('div');
    meta.className = 'mail-quota-meta';
    const left = document.createElement('span');
    left.textContent = (t('mail.quota') || 'Storage: {used} MiB / {total} MiB')
      .replace('{used}', String(Math.round(used / 1024 / 1024)))
      .replace('{total}', String(Math.round(total / 1024 / 1024)));
    const right = document.createElement('span');
    right.textContent = (t('mail.external_sends') || '{count}/{limit} external sends today')
      .replace('{count}', String(quota.external_sends))
      .replace('{limit}', String(quota.daily_external_limit));
    meta.appendChild(left);
    meta.appendChild(right);
    section.appendChild(meta);
    return section;
  }

  private buildSecuritySection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'mail-settings-card';
    const h2 = document.createElement('h2');
    h2.textContent = t('mail.settings_security') || 'Encryption';
    section.appendChild(h2);
    const list = document.createElement('ul');
    list.className = 'mail-security-list';
    const rows: Array<[string, string, string]> = [
      [
        'shield',
        t('mail.security_e2ee') || 'End-to-end encrypted',
        t('mail.security_e2ee_note') || 'Flaxia to Flaxia: only the members hold the keys.',
      ],
      [
        'lock',
        t('mail.security_at_rest') || 'Encrypted at rest',
        t('mail.security_at_rest_note') || 'External inbound mail is encrypted before it is stored.',
      ],
      [
        'mail-open',
        t('mail.security_tls') || 'TLS only',
        t('mail.security_tls_note') || 'External outbound mail is protected in transit, not E2EE.',
      ],
    ];
    for (const [iconName, title, note] of rows) {
      const item = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = 'mail-security-icon';
      mark.appendChild(icon(iconName as 'shield' | 'lock' | 'mail-open', { width: '16', height: '16' }));
      const body = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = title;
      const detail = document.createElement('span');
      detail.textContent = note;
      body.appendChild(strong);
      body.appendChild(detail);
      item.appendChild(mark);
      item.appendChild(body);
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
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
