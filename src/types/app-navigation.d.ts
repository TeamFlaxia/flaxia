// SvelteKit resolves $app/* at build time; the standalone tsc config used by
// CI does not include SvelteKit's generated ambient types, so declare the
// single API this module uses. Keep this in sync with @sveltejs/kit 3.x:
// `noScroll`/`keepFocus` were removed (and throw in dev), `replaceState` is
// deprecated in favour of `replace`.
declare module '$app/navigation' {
  export function goto(
    url: string | URL,
    options?: {
      replace?: boolean;
      /** @deprecated Use `replace`. */
      replaceState?: boolean;
      shallow?: boolean;
      reset?: boolean;
      state?: Record<string, unknown>;
      refreshAll?: boolean;
    },
  ): Promise<void>;

  /** Warm a route's JS chunk. Safe to call repeatedly. */
  export function preloadCode(...routeIds: string[]): Promise<void>;

  /**
   * Run a route's universal load ahead of navigation. Results are cached by
   * pathname + search and consumed by `goto()`. `invalidate()` clears that
   * cache, so prefetch code must never call it.
   */
  export function preloadData(
    href: string,
  ): Promise<
    | { type: 'loaded'; data: Record<string, unknown> }
    | { type: 'invalidated' }
    | { type: 'redirect'; location: string }
    | { type: 'error'; error: unknown }
  >;
}
