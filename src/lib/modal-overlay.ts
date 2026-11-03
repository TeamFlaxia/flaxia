import { registerModal } from './modal-state.js';

export interface ModalOverlayOptions {
  /** Accessible name for the dialog (aria-label). */
  label?: string;
  /** Id of an element that labels the dialog (aria-labelledby). */
  labelledBy?: string;
}

export interface ModalOverlay {
  overlay: HTMLDivElement;
  dialog: HTMLDivElement;
  unregister: () => void;
  close: () => void;
}

const TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Matches the exit animation in overlays.css (100ms, v5 calm motion). */
const EXIT_DURATION_MS = 100;
/** Safety net for animationend never firing (background tab, skipped frame). */
const EXIT_TIMEOUT_MS = EXIT_DURATION_MS + 80;

let dialogTitleId = 0;

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Runs the shared overlay exit animation and then calls done().
 *
 * Every overlay surface (modal, confirm, share, image lightbox) leaves with the
 * same 100ms fade + scale, so they share this helper instead of each copying
 * the timing. Reduced motion removes immediately: the foundation reset would
 * collapse the animation anyway and waiting would only delay the cleanup.
 */
export function closeWithAnimation(overlay: HTMLElement, done: () => void): void {
  if (overlay.classList.contains('is-closing')) return;
  if (prefersReducedMotion()) {
    overlay.remove();
    done();
    return;
  }

  let finished = false;
  let timer = 0;
  const finish = () => {
    if (finished) return;
    finished = true;
    overlay.removeEventListener('animationend', onAnimationEnd);
    window.clearTimeout(timer);
    overlay.remove();
    done();
  };
  const onAnimationEnd = (event: AnimationEvent) => {
    // Nested content (images, toasts) also animates; only the root counts.
    if (event.target === overlay) finish();
  };

  overlay.classList.add('is-closing');
  overlay.addEventListener('animationend', onAnimationEnd);
  timer = window.setTimeout(finish, EXIT_TIMEOUT_MS);
}

/** Focusable descendants of the given root, in DOM order (skips hidden/inert elements). */
export function getTabbableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    (element) => !element.closest('[inert]') && element.getClientRects().length > 0,
  );
}

export function createModalOverlay(dialogMaxWidth = '420px', options: ModalOverlayOptions = {}): ModalOverlay {
  const unregister = registerModal();
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let closed = false;
  let trapInstalled = false;

  const overlay = document.createElement('div');
  overlay.className = 'fx-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'fx-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  dialog.style.setProperty('--fx-dialog-max-width', dialogMaxWidth);
  if (options.label) dialog.setAttribute('aria-label', options.label);
  if (options.labelledBy) dialog.setAttribute('aria-labelledby', options.labelledBy);

  overlay.appendChild(dialog);

  const restoreFocus = () => {
    if (!previouslyFocused || previouslyFocused === document.body) return;
    if (!previouslyFocused.isConnected) return;
    previouslyFocused.focus({ preventScroll: true });
  };

  // Callers build their content after this function returns, so pick up the
  // dialog title (if any) as the accessible name once the overlay is mounted.
  const labelFromHeading = () => {
    if (dialog.hasAttribute('aria-label') || dialog.hasAttribute('aria-labelledby')) return;
    const heading = dialog.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
    if (!heading) return;
    if (!heading.id) {
      dialogTitleId += 1;
      heading.id = 'flaxia-dialog-title-' + String(dialogTitleId);
    }
    dialog.setAttribute('aria-labelledby', heading.id);
  };

  const focusInitial = () => {
    const [first] = getTabbableElements(dialog);
    (first ?? dialog).focus({ preventScroll: true });
  };

  const restoreFocusAfterExit = () => {
    // A dialog opened by the same click must keep focus; only reclaim it when
    // focus is still nowhere or inside the closing overlay.
    const active = document.activeElement;
    if (!active || active === document.body || overlay.contains(active)) restoreFocus();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown);
    unregister();
    closeWithAnimation(overlay, restoreFocusAfterExit);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (closed) return;
    if (!overlay.isConnected) {
      document.removeEventListener('keydown', onKeyDown);
      return;
    }
    // Only the dialog that actually contains the focused element reacts, so
    // stacked dialogs (e.g. a confirm opened from a modal) do not both fire.
    const target = event.target;
    if (!(target instanceof Node) || !dialog.contains(target)) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }

    if (event.key !== 'Tab') return;

    const tabbables = getTabbableElements(dialog);
    if (tabbables.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
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

  const activate = (): boolean => {
    if (closed || trapInstalled || !overlay.isConnected) return false;
    trapInstalled = true;
    labelFromHeading();
    document.addEventListener('keydown', onKeyDown);
    focusInitial();
    return true;
  };

  // Call sites mount the overlay right after creating it, so wait for the
  // current task to finish before installing the trap and moving focus.
  queueMicrotask(() => {
    if (activate() || closed) return;
    requestAnimationFrame(() => {
      activate();
    });
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return { overlay, dialog, unregister, close };
}

export interface MenuItemConfig {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export function createMenuItem(config: MenuItemConfig): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'fx-menu-item';
  if (config.danger) item.dataset.danger = 'true';
  item.textContent = config.label;
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    config.onClick();
  });
  return item;
}
