import { t } from './i18n.js';
import { closeWithAnimation, getTabbableElements } from './modal-overlay.js';
import { registerModal } from './modal-state.js';

export interface ConfirmDialogOptions {
  /** Optional heading used as the accessible name (rendered visually hidden). */
  title?: string;
  /** Focus the cancel button first; prefer this for destructive actions. */
  destructive?: boolean;
}

let confirmDialogId = 0;

export function createConfirmDialog(message: string, options: ConfirmDialogOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const unregister = registerModal();
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmDialogId += 1;
    const titleId = 'confirm-dialog-title-' + String(confirmDialogId);
    const messageId = 'confirm-dialog-message-' + String(confirmDialogId);
    let closed = false;

    const overlay = document.createElement('div');
    overlay.className = 'fx-overlay fx-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'fx-dialog fx-confirm';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;
    if (options.destructive) dialog.dataset.destructive = 'true';

    if (options.title) {
      const titleEl = document.createElement('h2');
      titleEl.id = titleId;
      titleEl.className = 'fx-visually-hidden';
      titleEl.textContent = options.title;
      dialog.appendChild(titleEl);
      dialog.setAttribute('aria-labelledby', titleId);
      dialog.setAttribute('aria-describedby', messageId);
    } else {
      // No heading is available: the message doubles as the dialog's name.
      // aria-describedby is skipped here so screen readers do not read it twice.
      dialog.setAttribute('aria-labelledby', messageId);
    }

    // shadcn alert-dialog: title/description only, no icon burst.
    const messageEl = document.createElement('p');
    messageEl.id = messageId;
    messageEl.className = 'fx-confirm__message';
    messageEl.textContent = message;
    dialog.appendChild(messageEl);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'fx-confirm__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'fx-btn fx-btn--secondary';
    cancelBtn.textContent = t('common.cancel') || 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'fx-btn fx-btn--primary';
    confirmBtn.textContent = t('common.confirm') || 'OK';

    const restoreFocus = () => {
      if (!previouslyFocused || previouslyFocused === document.body) return;
      if (!previouslyFocused.isConnected) return;
      previouslyFocused.focus({ preventScroll: true });
    };

    const focusInitial = () => {
      (options.destructive ? cancelBtn : confirmBtn).focus({ preventScroll: true });
    };

    const handleKey = (e: KeyboardEvent) => {
      if (closed) return;
      if (!overlay.isConnected) {
        window.removeEventListener('keydown', handleKey);
        return;
      }
      // Ignore keys typed outside this dialog (a stacked modal keeps its own focus).
      const target = e.target;
      if (!(target instanceof Node) || !dialog.contains(target)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        destroy(false);
        return;
      }
      if (e.key === 'Enter') {
        // Buttons activate natively; only confirm when focus is elsewhere in the dialog.
        if (target instanceof HTMLButtonElement) return;
        e.preventDefault();
        destroy(true);
        return;
      }
      if (e.key !== 'Tab') return;

      const tabbables = getTabbableElements(dialog);
      if (tabbables.length === 0) {
        e.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const active = document.activeElement;
      const activeIndex = active instanceof HTMLElement ? tabbables.indexOf(active) : -1;

      if (activeIndex === -1) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (!e.shiftKey && activeIndex === tabbables.length - 1) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && activeIndex === 0) {
        e.preventDefault();
        last.focus();
      }
    };
    window.addEventListener('keydown', handleKey);

    function destroy(result: boolean) {
      if (closed) return;
      closed = true;
      window.removeEventListener('keydown', handleKey);
      unregister();
      // Resolve first so the caller's next step is not held up by the exit
      // animation; the overlay itself is removed once the animation ends.
      resolve(result);
      closeWithAnimation(overlay, () => {
        const active = document.activeElement;
        if (!active || active === document.body || overlay.contains(active)) restoreFocus();
      });
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
    focusInitial();
  });
}
