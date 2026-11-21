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
}
