// Flaxia-owned consent UI for the Crowd browser node. `@flaxia/node` delegates
// to this via `consent.onConsentRequired`, so the modal matches Flaxia's design
// and i18n instead of the node bundle's built-in shadow-DOM banner.
import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';

export interface CrowdConsentModalOptions {
  /** Persist consent and start the node. */
  onAccept: () => void;
  /** Persist denial. */
  onReject: () => void;
}

const overlayStyle = `
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
`;

const dialogStyle = `
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
  max-width: 480px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
`;

function buttonStyle(primary: boolean): string {
  return `
    padding: 10px 20px;
    border-radius: 9999px;
    font-size: 14px;
    cursor: pointer;
    font-family: inherit;
    ${
      primary
        ? 'background: var(--accent); border: none; color: #000; font-weight: 600;'
        : 'background: transparent; border: 1px solid var(--border); color: var(--text-primary);'
    }
  `;
}

/**
 * Render the consent modal. Dismissing it (× / Esc / backdrop) leaves the
 * decision unset so the visitor is asked again later; only the explicit
 * buttons persist a choice.
 */
export function showCrowdConsentModal(options: CrowdConsentModalOptions): void {
  const unregister = registerModal();

  const overlay = document.createElement('div');
  overlay.style.cssText = overlayStyle;

  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'crowd-consent-title');
  dialog.style.cssText = dialogStyle;
  dialog.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 id="crowd-consent-title" style="margin: 0; font-size: 18px; color: var(--text-primary);">
        ${t('crowd.consent_title')}
      </h3>
      <button class="crowd-consent-close" aria-label="${t('common.close')}" style="
        background: none; border: none; color: var(--text-muted);
        font-size: 20px; cursor: pointer; line-height: 1;
      ">✕</button>
    </div>
    <p style="margin: 0 0 12px; color: var(--text-primary); font-size: 14px; line-height: 1.6;">
      ${t('crowd.consent_body')}
    </p>
    <p style="margin: 0 0 20px; color: var(--text-muted); font-size: 12px; line-height: 1.6;">
      ${t('crowd.consent_note')}
      <a href="/privacy" target="_blank" rel="noopener noreferrer" style="color: var(--accent);">
        ${t('crowd.consent_privacy_link')}
      </a>
    </p>
    <div style="display: flex; justify-content: flex-end; gap: 12px;">
      <button class="crowd-consent-reject" style="${buttonStyle(false)}">
        ${t('crowd.consent_reject')}
      </button>
      <button class="crowd-consent-accept" style="${buttonStyle(true)}">
        ${t('crowd.consent_accept')}
      </button>
    </div>
  `;

  overlay.appendChild(dialog);

  let settled = false;
  const close = () => {
    unregister();
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  };
  const finish = (accepted: boolean) => {
    if (settled) return;
    settled = true;
    close();
    if (accepted) options.onAccept();
    else options.onReject();
  };
  const dismiss = () => {
    if (settled) return;
    settled = true;
    close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };

  dialog.querySelector('.crowd-consent-close')?.addEventListener('click', dismiss);
  dialog.querySelector('.crowd-consent-reject')?.addEventListener('click', () => finish(false));
  dialog.querySelector('.crowd-consent-accept')?.addEventListener('click', () => finish(true));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });
  document.addEventListener('keydown', onKeyDown);

  document.body.appendChild(overlay);
  (dialog.querySelector('.crowd-consent-accept') as HTMLButtonElement | null)?.focus();
}
