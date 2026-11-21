// SvelteKit resolves $app/* at build time; the standalone tsc config used by
// CI does not include SvelteKit's generated ambient types, so declare the
// single API this module uses.
declare module '$app/navigation' {
  export function goto(
    url: string | URL,
    options?: {
      replaceState?: boolean;
      state?: Record<string, unknown>;
      noScroll?: boolean;
      keepFocus?: boolean;
    },
  ): Promise<void>;
}
