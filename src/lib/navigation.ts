// Single entry point for programmatic navigation.
//
// The legacy app navigated by mutating the URL with history.pushState and
// dispatching custom events. SvelteKit keeps its own router state in
// history.state (`sveltekit:metadata`); replacing that object makes the router
// stop reacting to the URL, which is why links only worked after a full reload.
// Routing every navigation through goto() keeps SvelteKit's state intact.
import { goto } from '$app/navigation';

export interface NavigateOptions {
  replaceState?: boolean;
  state?: Record<string, unknown>;
  noScroll?: boolean;
}

export function navigate(url: string, options: NavigateOptions = {}): Promise<void> {
  return goto(url, {
    replaceState: options.replaceState ?? false,
    state: options.state ?? {},
    noScroll: options.noScroll ?? false,
    keepFocus: false,
  });
}

/** Replace the current entry — used by the legacy spaNavigate bridge, where
 * the caller has already written the URL with pushState. */
export function navigateReplace(url: string, state: Record<string, unknown> = {}): Promise<void> {
  return navigate(url, { replaceState: true, state });
}
