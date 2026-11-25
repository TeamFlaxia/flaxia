// Non-blocking shell boot.
//
// The root universal load used to `await` locale files and /api/me before any
// route component mounted. Because SSR returns no data from that load, it is
// re-run on every hard load, so the browser painted a complete SSR page but
// attached no click handlers until those two network requests resolved.
//
// Boot is now started fire-and-forget and awaited only by onMount (which needs
// the locale to re-render head metadata). Route components render immediately
// with their existing synchronous fallbacks.
let bootPromise: Promise<void> | null = null;

export function bootShell(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (!bootPromise) {
    bootPromise = (async () => {
      const [{ initShellBootstrap }, { initI18n }, { loadSessionUser }] = await Promise.all([
        import('./bootstrap.ts'),
        import('../i18n.ts'),
        import('./session.ts'),
      ]);
      // Patch fetch before the two boot requests go out.
      initShellBootstrap();
      await Promise.all([initI18n(), loadSessionUser()]);
    })().catch((error: unknown) => {
      // A transient boot failure must not poison the app forever.
      bootPromise = null;
      throw error;
    });
  }
  return bootPromise;
}
