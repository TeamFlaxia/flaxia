import { t } from './i18n.js';
import { registerModal } from './modal-state.js';

export function createConfirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const unregister = registerModal();

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 3000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2rem;
      max-width: 400px;
      width: 90%;
      text-align: center;
    `;

    const messageEl = document.createElement('p');
    messageEl.textContent = message;
    messageEl.style.cssText = `
      margin: 0 0 1.5rem 0;
      font-size: 1rem;
      color: var(--text-primary);
      line-height: 1.5;
    `;
    dialog.appendChild(messageEl);

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = `
      display: flex;
      gap: 0.75rem;
      justify-content: center;
    `;

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('common.cancel') || 'Cancel';
    cancelBtn.style.cssText = `
      padding: 0.5rem 1.25rem;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.875rem;
    `;

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = t('common.confirm') || 'OK';
    confirmBtn.style.cssText = `
      padding: 0.5rem 1.25rem;
      border: none;
      border-radius: 4px;
      background: var(--accent);
      color: #fff;
      cursor: pointer;
      font-size: 0.875rem;
    `;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.removeEventListener('keydown', handleKey);
        destroy(false);
      }
      if (e.key === 'Enter') {
        window.removeEventListener('keydown', handleKey);
        destroy(true);
      }
    };
    window.addEventListener('keydown', handleKey);

    function destroy(result: boolean) {
      window.removeEventListener('keydown', handleKey);
      unregister();
      if (overlay.parentNode) overlay.remove();
      resolve(result);
    }

    cancelBtn.addEventListener('click', () => destroy(false));
    confirmBtn.addEventListener('click', () => destroy(true));

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) destroy(false);
    });

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(confirmBtn);
    dialog.appendChild(buttonRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  });
}
