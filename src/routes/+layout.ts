// Native shells build with adapter-static and a client-only SPA.
export const ssr = import.meta.env.BUILD_TARGET !== 'native';
export const prerender = false;

// Legacy components call t() while building their DOM, so locale strings must
// be loaded before any route component mounts.
export async function load() {
  if (typeof window === 'undefined') return {};
  const [{ initShellBootstrap }, { initI18n }, { loadSessionUser }] = await Promise.all([
    import('../lib/svelte/bootstrap.ts'),
    import('../lib/i18n.ts'),
    import('../lib/svelte/session.ts'),
  ]);
  // Patch fetch first, but the two independent boot requests can run together.
  initShellBootstrap();
  await Promise.all([initI18n(), loadSessionUser()]);
  return {};
}
