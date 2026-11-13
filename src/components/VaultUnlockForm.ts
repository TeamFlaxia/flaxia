// Compact vault unlock form for screens outside Settings (currently Mail
// settings). The full setup/recovery/device-management UI stays in
// VaultSection; this component only unlocks VK with the password (or the
// device key), and points the user at Settings for setup or QR pairing.
import { t } from '../lib/i18n.js';
import { fetchVaultKeys } from '../lib/vault/client.js';
import { isVaultUnlocked, tryDeviceUnlock, unlockVault } from '../lib/vault/session.js';

export interface VaultUnlockFormOptions {
  onUnlocked: () => void;
}

export interface VaultUnlockForm {
  getElement: () => HTMLElement;
  destroy: () => void;
}

const LABEL_CSS = 'display:block;margin-bottom:0.5rem;font-weight:500;color:var(--text-primary);';
const INPUT_CSS = `
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 1rem;
  border-radius: 4px;
  box-sizing: border-box;
`;
const BUTTON_CSS = `
  padding: 0.6rem 1.25rem;
  border: none;
  border-radius: 4px;
  background: var(--accent);
  color: var(--on-accent);
  cursor: pointer;
  font-size: 0.9rem;
`;
const SECONDARY_CSS = `
  padding: 0.6rem 1.25rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 0.9rem;
`;
const MUTED_CSS = 'font-size:0.85rem;color:var(--text-secondary);line-height:1.5;margin:0.5rem 0;';
const MESSAGE_CSS = 'font-size:0.85rem;margin-top:0.75rem;min-height:1.1em;line-height:1.4;';
const BUTTON_ROW_CSS = 'display:flex;gap:0.75rem;flex-wrap:wrap;margin-top:1rem;align-items:center;';

function row(): HTMLElement {
  const node = document.createElement('div');
  node.style.cssText = BUTTON_ROW_CSS;
  return node;
}

function button(text: string, css = BUTTON_CSS): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.style.cssText = css;
  node.textContent = text;
  return node;
}

function openSettings(): void {
  window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'settings' } }));
}

export function createVaultUnlockForm(options: VaultUnlockFormOptions): VaultUnlockForm {
  const container = document.createElement('div');
  container.className = 'vault-unlock-form';

  let enabled: boolean | null = null;
  let loadError = false;
  let busy = false;
  let done = false;
  let message = '';

  function finish(): void {
    if (done) return;
    done = true;
    options.onUnlocked();
  }

  function render(): void {
    container.replaceChildren();

    if (enabled === null && !loadError) {
      const waiting = document.createElement('p');
      waiting.style.cssText = MUTED_CSS;
      waiting.textContent = t('settings.vault_awaiting') || 'Checking vault status…';
      container.appendChild(waiting);
      return;
    }

    if (loadError) {
      const error = document.createElement('p');
      error.style.cssText = `${MESSAGE_CSS}color:var(--danger);`;
      error.textContent = t('settings.network_error') || 'Network error';
      container.appendChild(error);
      const retry = button(t('common.retry') || 'Retry', SECONDARY_CSS);
      retry.addEventListener('click', () => {
        loadError = false;
        enabled = null;
        render();
        void init();
      });
      container.appendChild(retry);
      return;
    }

    if (enabled === false) {
      const hint = document.createElement('p');
      hint.style.cssText = MUTED_CSS;
      hint.textContent =
        t('settings.vault_not_setup') || 'The Personal Vault is not set up yet. Set it up in Settings first.';
      container.appendChild(hint);
      const settingsButton = button(t('settings.vault_open_settings') || 'Open Settings', SECONDARY_CSS);
      settingsButton.addEventListener('click', openSettings);
      container.appendChild(settingsButton);
      return;
    }

    const hint = document.createElement('p');
    hint.style.cssText = MUTED_CSS;
    hint.textContent =
      t('settings.vault_locked_hint') || 'Unlock with your account password, or pair this device by QR code.';
    container.appendChild(hint);

    const label = document.createElement('label');
    label.style.cssText = LABEL_CSS;
    label.textContent = t('settings.vault_password') || 'Account password';
    container.appendChild(label);

    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.placeholder = t('settings.vault_password_ph') || 'Your account password';
    input.style.cssText = `${INPUT_CSS}margin-bottom:0.75rem;`;
    container.appendChild(input);

    const unlock = button(t('settings.vault_unlock') || 'Unlock');
    const msg = document.createElement('div');
    msg.style.cssText = `${MESSAGE_CSS}color:var(--danger);`;
    msg.textContent = message;
    msg.style.display = message ? 'block' : 'none';

    const doUnlock = () => {
      const password = input.value;
      if (!password || busy || done) return;
      busy = true;
      unlock.disabled = true;
      unlock.textContent = t('settings.vault_working') || 'Working…';
      void (async () => {
        const outcome = await unlockVault(password);
        busy = false;
        unlock.disabled = false;
        unlock.textContent = t('settings.vault_unlock') || 'Unlock';
        if (outcome === 'ok') {
          finish();
          return;
        }
        message =
          outcome === 'wrong'
            ? t('settings.vault_wrong_password') || 'Wrong password'
            : outcome === 'network'
              ? t('settings.network_error') || 'Network error'
              : t('settings.vault_error') || 'Something went wrong';
        msg.textContent = message;
        msg.style.display = 'block';
        input.focus();
      })();
    };
    unlock.addEventListener('click', doUnlock);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') doUnlock();
    });
    container.appendChild(unlock);

    const buttons = row();
    const settingsButton = button(
      t('settings.vault_pair_in_settings') || 'Pair this device in Settings',
      SECONDARY_CSS,
    );
    settingsButton.addEventListener('click', openSettings);
    buttons.appendChild(settingsButton);
    container.appendChild(buttons);
    container.appendChild(msg);

    input.focus();
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
    if (!keys) {
      loadError = true;
      render();
      return;
    }
    enabled = keys.enabled === true;
    render();
  }

  render();
  void init();

  return {
    getElement: () => container,
    destroy: () => container.remove(),
  };
}
