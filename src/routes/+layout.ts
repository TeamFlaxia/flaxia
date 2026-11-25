// Native shells build with adapter-static and a client-only SPA.
export const ssr = import.meta.env.BUILD_TARGET !== 'native';
export const prerender = false;

import { bootShell } from '../lib/svelte/shell-boot.ts';

// Locale strings are needed by legacy components, but waiting for the two
// locale files here blocked hydration of the entire app. Start that work
// fire-and-forget; +layout.svelte awaits it in onMount for head metadata.
//
// The session snapshot, on the other hand, is read synchronously by route
// components (settings, mail, profile, auth guards) during their onMount. It
// must be resolved before they mount or they render as guests / redirect.
export async function load() {
  if (typeof window === 'undefined') return {};
  void bootShell().catch(() => {
    // Locale boot degrades to translation keys; routes still mount.
  });
  const { loadSessionUser } = await import('../lib/svelte/session.ts');
  await loadSessionUser();
  return {};
}
