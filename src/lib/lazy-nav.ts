// Lazy-loaded navigation component factories (deferred from the initial
// bundle). Split out of main.ts: the bootstrap only needs these after login.
let _createBottomNav: typeof import('../components/BottomNav.js')['createBottomNav'] | null = null;

export const lazyCreateBottomNav: (
  ...args: Parameters<typeof import('../components/BottomNav.js')['createBottomNav']>
) => Promise<ReturnType<typeof import('../components/BottomNav.js')['createBottomNav']>> = async (...args) => {
  if (!_createBottomNav) {
    const mod = await import('../components/BottomNav.js');
    _createBottomNav = mod.createBottomNav;
  }
  return _createBottomNav(...args);
};
