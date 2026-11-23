import { closeWithAnimation, getTabbableElements } from '../modal-overlay.js';
import { getModalCount, registerModal } from '../modal-state.js';

export interface ModalBehaviorOptions {
  overlay: HTMLElement;
  dialog: HTMLElement;
  /** Runs when the dialog closes normally (the adapter unmounts the view). */
  onClose: () => void;
  /** Return false to temporarily block closing (upload in flight). */
  canClose?: () => boolean;
  /** Initial focus target; defaults to the first tabbable element. */
  initialFocus?: () => HTMLElement | null;
  /** Run the shared overlay exit animation before closing. */
  animated?: boolean;
}

export interface ModalBehavior {
  /** Close the dialog; `after` replaces `onClose` for the quote-share path. */
  close: (after?: () => void) => void;
  /** Called from the component's teardown; restores focus and unlocks scroll. */
  destroy: () => void;
}

/**
 * Shared dialog behaviour for the Svelte modals: modal registration, focus
 * trapping, Escape/stacking rules and focus restoration. The markup lives in
 * Svelte; this keeps the accessibility contract identical to the legacy
 * factories without constructing any DOM.
 */
export function attachModalBehavior(options: ModalBehaviorOptions): ModalBehavior {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const unregister = registerModal();
  let closed = false;

  const restoreFocus = () => {
    if (!previouslyFocused || previouslyFocused === document.body) return;
    if (!previouslyFocused.isConnected) return;
    previouslyFocused.focus({ preventScroll: true });
  };

  const teardown = () => {
    document.removeEventListener('keydown', onKeyDown);
    unregister();
  };

  const finish = (after?: () => void) => {
    if (after) {
      after();
      return;
    }
    options.onClose();
    restoreFocus();
  };

  const close = (after?: () => void) => {
    if (closed) return;
    if (options.canClose && !options.canClose()) return;
    closed = true;
    teardown();
    if (options.animated) {
      closeWithAnimation(options.overlay, () => finish(after));
    } else {
      finish(after);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (closed) return;
    const target = event.target;
    // Only the dialog that owns focus reacts, so stacked dialogs don't both fire.
    if (!(target instanceof Node) || !options.dialog.contains(target)) return;

    if (event.key === 'Escape') {
      if (getModalCount() > 1) return;
      event.preventDefault();
      close();
      return;
    }

    if (event.key !== 'Tab') return;

    const tabbables = getTabbableElements(options.dialog);
    if (tabbables.length === 0) {
      event.preventDefault();
      options.dialog.focus({ preventScroll: true });
      return;
    }

    const first = tabbables[0];
    const last = tabbables[tabbables.length - 1];
    const active = document.activeElement;
    const activeIndex = active instanceof HTMLElement ? tabbables.indexOf(active) : -1;

    if (activeIndex === -1) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (!event.shiftKey && activeIndex === tabbables.length - 1) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && activeIndex === 0) {
      event.preventDefault();
      last.focus();
    }
  };

  document.addEventListener('keydown', onKeyDown);

  // Wait for the caller to mount the host before moving focus.
  queueMicrotask(() => {
    if (closed || !options.overlay.isConnected) return;
    const target = options.initialFocus?.() ?? getTabbableElements(options.dialog)[0] ?? options.dialog;
    target.focus({ preventScroll: true });
  });

  return {
    close,
    destroy: () => {
      if (closed) return;
      closed = true;
      teardown();
      restoreFocus();
    },
  };
}
