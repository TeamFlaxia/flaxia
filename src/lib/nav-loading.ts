/**
 * Inline navigation spinner.
 *
 * The router builds the next view in a detached staging root. When the current
 * view has been parked (or there is no view yet) the content column would
 * otherwise stay blank until the dynamic import and the first API response
 * settle, so we mount a single status element while that happens.
 *
 * The element is deliberately owned by the module: concurrent navigations may
 * overlap, and the newest navigation is the only one allowed to remove it.
 */
import { t } from './i18n.ts';

const SPINNER_ID = 'nav-loading';

let spinner: HTMLElement | null = null;

function createSpinner(): HTMLElement {
  const element = document.createElement('div');
  element.id = SPINNER_ID;
  element.className = 'nav-loading';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');

  const ring = document.createElement('div');
  ring.className = 'nav-loading-spinner';
  ring.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'nav-loading-label';
  label.textContent = t('common.loading');

  element.appendChild(ring);
  element.appendChild(label);
  return element;
}

/** Show the spinner inside `root` (normally `#app`). Idempotent. */
export function showNavigationSpinner(root: HTMLElement): void {
  if (!spinner) spinner = createSpinner();
  if (spinner.parentNode !== root) root.appendChild(spinner);
}

/** Remove the spinner. Safe to call when it was never shown. */
export function hideNavigationSpinner(): void {
  spinner?.remove();
  spinner = null;
}

/** Test/teardown helper: true while the spinner is mounted. */
export function isNavigationSpinnerMounted(): boolean {
  return spinner?.parentNode !== null && spinner?.parentNode !== undefined;
}
