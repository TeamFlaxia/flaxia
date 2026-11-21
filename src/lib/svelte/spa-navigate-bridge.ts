// Legacy callers still push a URL with pushState/pushSpaHistory and emit
// `spaNavigate`. Route that through SvelteKit's goto() instead of dispatching a
// synthetic popstate: replacing history.state broke the router, so the URL
// changed but the view did not until a full reload.
import { navigateReplace } from '../navigation.ts';

let started = false;

export function initSpaNavigateBridge(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('spaNavigate', () => {
    const url = `${window.location.pathname}${window.location.search}`;
    void navigateReplace(url).catch(() => {
      // If goto fails, a full navigation still reaches the right URL.
      window.location.assign(url);
    });
  });
}
