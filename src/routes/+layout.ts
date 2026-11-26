// Native shells build with adapter-static and a client-only SPA.
export const ssr = import.meta.env.BUILD_TARGET !== 'native';
export const prerender = false;

import { bootShell } from '../lib/svelte/shell-boot.ts';

// Locale strings and the session snapshot are read synchronously by legacy
// components while they build their DOM. When the SSR hook injected the boot
// data, both are already inlined and the load must not become a network gate:
// start the shell side effects without awaiting them. Native builds and
// degraded SSR (e.g. /api/me failed) keep the original await so translation
// keys and guest redirects cannot regress.
export async function load() {
  if (typeof window === 'undefined') return {};
  const bootWindow = window as typeof window & { __FLAXIA_BOOT__?: boolean };
  const canUseBoot = typeof import.meta.env === 'undefined' || import.meta.env.BUILD_TARGET !== 'native';
  if (canUseBoot && bootWindow.__FLAXIA_BOOT__) {
    void bootShell().catch(() => {
      // onMount attaches its own handler; keep this starter quiet.
    });
    return {};
  }
  await bootShell();
  return {};
}
