// Native shells build with adapter-static and a client-only SPA.
export const ssr = import.meta.env.BUILD_TARGET !== 'native';
export const prerender = false;

import { bootShell } from '../lib/svelte/shell-boot.ts';

// Locale strings and the session snapshot are read synchronously by legacy
// components while they build their DOM. Resolving them here keeps SSR text
// and client text identical and prevents auth guards from treating signed-in
// users as guests. The latency work in this change happens after this gate
// (SSR click delegation, cached loads, deduped auth, deferred Crowd node).
export async function load() {
  if (typeof window === 'undefined') return {};
  await bootShell();
  return {};
}
