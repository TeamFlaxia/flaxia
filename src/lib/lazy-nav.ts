// Lazy-loaded navigation component factories (deferred from the initial
// bundle). Split out of main.ts: the bootstrap only needs these after login.
let _createBottomNav: typeof import('../components/BottomNav.js')['createBottomNav'] | null = null;
let _createLeftNav: typeof import('../components/LeftNav.js')['createLeftNav'] | null = null;
let _updateLeftNavUser: typeof import('../components/LeftNav.js')['updateLeftNavUser'] | null = null;

export const lazyCreateBottomNav: (
  ...args: Parameters<typeof import('../components/BottomNav.js')['createBottomNav']>
) => Promise<ReturnType<typeof import('../components/BottomNav.js')['createBottomNav']>> = async (...args) => {
  if (!_createBottomNav) {
    const mod = await import('../components/BottomNav.js');
    _createBottomNav = mod.createBottomNav;
  }
  return _createBottomNav(...args);
};

export const lazyCreateLeftNav: (
  ...args: Parameters<typeof import('../components/LeftNav.js')['createLeftNav']>
) => Promise<ReturnType<typeof import('../components/LeftNav.js')['createLeftNav']>> = async (...args) => {
  if (!_createLeftNav) {
    const mod = await import('../components/LeftNav.js');
    _createLeftNav = mod.createLeftNav;
    _updateLeftNavUser = mod.updateLeftNavUser;
  }
  return _createLeftNav(...args);
};

export const lazyUpdateLeftNavUser: typeof import('../components/LeftNav.js')['updateLeftNavUser'] = (...args) => {
  if (!_updateLeftNavUser) {
    throw new Error('updateLeftNavUser not yet loaded');
  }
  return _updateLeftNavUser(...args);
};
