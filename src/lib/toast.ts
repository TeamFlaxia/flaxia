/**
 * Toasts: a shadcn-style card (bg-elevated + hairline + shadow) that slides up
 * from the bottom, shows a 2px primary progress line for its 3s lifetime,
 * then slides back down.
 *
 * Presentation lives in src/styles/redesign/overlays.css (.fx-toast); this
 * module only builds the live region, arms the timers and cleans up.
 */
const TOAST_LIFETIME_MS = 3000;
const TOAST_EXIT_MS = 100;

let layer: HTMLDivElement | null = null;

function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Single fixed container so stacked toasts never overlap and stay centred. */
function getLayer(): HTMLDivElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement('div');
  layer.id = 'fx-toast-layer';
  document.body.appendChild(layer);
  return layer;
}

export function showToast(message: string, isError: boolean = false): void {
  const reducedMotion = prefersReducedMotion();
  const toast = document.createElement('div');
  toast.className = 'fx-toast';
  if (isError) toast.dataset.variant = 'error';
  // Errors interrupt (alert/assertive); everything else is announced politely.
  toast.setAttribute('role', isError ? 'alert' : 'status');
  toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  toast.setAttribute('aria-atomic', 'true');

  const dot = document.createElement('span');
  dot.className = 'fx-toast__dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'fx-toast__message';

  const progress = document.createElement('span');
  progress.className = 'fx-toast__progress';
  progress.setAttribute('aria-hidden', 'true');

  toast.appendChild(dot);
  toast.appendChild(text);
  toast.appendChild(progress);

  // Append first, then fill the live region so assistive tech observes a
  // content change instead of an already-populated node.
  getLayer().appendChild(toast);
  text.textContent = message;

  const remove = () => {
    toast.remove();
  };

  const dismiss = () => {
    if (reducedMotion) {
      remove();
      return;
    }
    if (toast.classList.contains('is-leaving')) return;
    toast.classList.add('is-leaving');

    let removed = false;
    const finish = () => {
      if (removed) return;
      removed = true;
      toast.removeEventListener('animationend', onAnimationEnd);
      remove();
    };
    const onAnimationEnd = (event: AnimationEvent) => {
      // The progress bar finishes on its own schedule; only the exit counts.
      if (event.target === toast && event.animationName === 'fx-toast-out') finish();
    };
    toast.addEventListener('animationend', onAnimationEnd);
    window.setTimeout(finish, TOAST_EXIT_MS + 60);
  };

  window.setTimeout(dismiss, TOAST_LIFETIME_MS);
}
