// Native shells build with adapter-static and a client-only SPA.
export const ssr = import.meta.env.BUILD_TARGET !== 'native';
export const prerender = false;

import { bootShell } from '../lib/svelte/shell-boot.ts';

// Locale strings and the session snapshot are needed by legacy components, but
// waiting for them here blocks hydration of the entire app. Start boot without
// awaiting it; +layout.svelte awaits the same promise in onMount to re-render
// metadata once the locale is known.
export function load() {
  if (typeof window === 'undefined') return {};
  void bootShell().catch(() => {
    // The shell degrades to translation keys / guest state; routes still mount.
  });
  return {};
}
