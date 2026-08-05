/**
 * Centralized client-side navigation. Pushes a new history entry and signals
 * the SPA router (which listens for `popstate`) to re-parse the URL.
 *
 * Replaces the previous ad-hoc `history.pushState` + dispatched
 * `PopStateEvent('popstate')` pair scattered across components.
 */
export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
