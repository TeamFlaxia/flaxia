// Single entry point for programmatic navigation.
//
// The legacy app navigated by mutating the URL with history.pushState and
// dispatching custom events. SvelteKit keeps its own router state in
// history.state (`sveltekit:metadata`); replacing that object makes the router
// stop reacting to the URL, which is why links only worked after a full reload.
// Routing every navigation through goto() keeps SvelteKit's state intact.
import { goto, preloadCode, preloadData } from '$app/navigation';
import { isDataSaverEnabled } from './settings.ts';

export interface NavigateOptions {
  replaceState?: boolean;
  state?: Record<string, unknown>;
  /** Reset scroll and focus after the navigation (SvelteKit default: true). */
  reset?: boolean;
}

export function navigate(url: string, options: NavigateOptions = {}): Promise<void> {
  // SvelteKit 3 removed `noScroll`/`keepFocus`; passing them throws in dev.
  // `reset` defaults to true, which matches the previous scroll-to-top behavior.
  return goto(url, {
    replace: options.replaceState ?? false,
    state: options.state ?? {},
    reset: options.reset ?? true,
  });
}

/** Replace the current entry — used by the legacy spaNavigate bridge, where
 * the caller has already written the URL with pushState. */
export function navigateReplace(url: string, state: Record<string, unknown> = {}): Promise<void> {
  return navigate(url, { replaceState: true, state });
}

const THREAD_ROUTE_ID = '/thread/[id]';
const PREFETCH_DELAY_MS = 100;
const prefetchedThreads = new Set<string>();
const pendingThreads = new Map<string, ReturnType<typeof setTimeout>>();

if (typeof window !== 'undefined') {
  // A post can change after its thread was prefetched (game version commit,
  // edit, reply). Drop the warmed load data so the next visit fetches the
  // current root instead of replaying the initial snapshot.
  window.addEventListener('postUpdated', () => {
    for (const timer of pendingThreads.values()) clearTimeout(timer);
    pendingThreads.clear();
    prefetchedThreads.clear();
  });
}

/**
 * Warm a thread's load data and route code after a short hover intent delay.
 * `preloadData` fills SvelteKit's load cache (keyed by pathname + search), so
 * the subsequent `goto()` reuses it. Never invalidate the load cache here: it
 * throws away the prefetched data and makes the prefetch pointless.
 */
export function prefetchThread(href: string): void {
  if (typeof window === 'undefined' || isDataSaverEnabled()) return;
  if (prefetchedThreads.has(href) || pendingThreads.has(href)) return;
  const timer = setTimeout(() => {
    pendingThreads.delete(href);
    if (prefetchedThreads.has(href)) return;
    if (prefetchedThreads.size > 256) prefetchedThreads.clear();
    prefetchedThreads.add(href);
    void preloadData(href).catch(() => {});
    void preloadCode(THREAD_ROUTE_ID).catch(() => {});
  }, PREFETCH_DELAY_MS);
  pendingThreads.set(href, timer);
}
