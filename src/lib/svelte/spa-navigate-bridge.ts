// The legacy main.ts used to listen for `spaNavigate` and switch views. After
// its removal, legacy DOM callers still push a URL with pushState/pushSpaHistory
// and emit `spaNavigate` — but nothing told SvelteKit's router about the new
// URL, so only the address bar changed. Translate that custom event into the
// popstate the SvelteKit router listens for. Callers have already updated the
// URL by the time this runs.
let started = false;

export function initSpaNavigateBridge(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('spaNavigate', () => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}
