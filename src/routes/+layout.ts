export const ssr = false;
export const prerender = false;

// Legacy components call t() while building their DOM, so locale strings must
// be loaded before any route component mounts.
export async function load() {
  if (typeof window === 'undefined') return {};
  const { initI18n } = await import('../lib/i18n.ts');
  const { loadSessionUser } = await import('../lib/svelte/session.ts');
  await initI18n();
  await loadSessionUser();
  return {};
}
