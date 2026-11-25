/**
 * Inline navigation spinner and top progress bar.
 *
 * The router builds the next view in a detached staging root. When the current
 * view has been parked (or there is no view yet) the content column would
 * otherwise stay blank until the dynamic import and the first API response
 * settle, so we mount a single status element while that happens. Client-side
 * navigation additionally shows a fixed 2px progress bar at the top of the
 * viewport so the click reads as answered immediately.
 *
 * Both elements are deliberately owned by the module: concurrent navigations
 * may overlap, and the newest navigation is the only one allowed to remove
 * them. A watchdog covers navigations that never report completion.
 */
import { t } from './i18n.ts';

const SPINNER_ID = 'nav-loading';
const PROGRESS_ID = 'nav-progress';
const WATCHDOG_MS = 6000;

let spinner: HTMLElement | null = null;
let progress: HTMLElement | null = null;
let generation = 0;
let watchdog: ReturnType<typeof setTimeout> | null = null;

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

function createProgress(): HTMLElement {
  const element = document.createElement('div');
  element.id = PROGRESS_ID;
  element.className = 'nav-progress';
  element.setAttribute('role', 'progressbar');
  element.setAttribute('aria-label', t('common.loading'));
  return element;
}

function clearWatchdog(): void {
  if (watchdog !== null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

/** Remove the active bar, but only for the generation that still owns it. */
function finishNavigation(token: number): void {
  if (token !== generation) return; // stale cleanup from an older navigation
  generation += 1; // later duplicates and stale tokens are now ignored too
  clearWatchdog();
  progress?.remove();
  progress = null;
}

/**
 * Mark a navigation as started and return the token that owns the bar. Pass
 * that token to `endNavigation` so a late cleanup from an earlier navigation
 * cannot remove the bar belonging to a newer one.
 */
export function beginNavigation(): number {
  const token = ++generation;
  clearWatchdog();
  if (typeof document === 'undefined') return token; // SSR: hooks run in the browser

  if (!progress) progress = createProgress();
  if (progress.parentNode !== document.body) document.body.appendChild(progress);
  watchdog = setTimeout(() => finishNavigation(token), WATCHDOG_MS);
  return token;
}

/** Complete a navigation. Without a token, the current generation is assumed. */
export function endNavigation(token: number = generation): void {
  finishNavigation(token);
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
