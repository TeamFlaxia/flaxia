// Mobile bottom-nav lifecycle (split out of main.ts).
//
// Single global instance, created once and mounted to the body. Navigation
// and the current user come from the bootstrap via BottomNavDeps so this
// module stays decoupled from the app shell.
import type { BottomNav, BottomNavProps } from '../components/BottomNav.js';
import { lazyCreateBottomNav } from './lazy-nav.js';
import type { RouteView } from './router.js';

export interface BottomNavDeps {
  navigate: (view: RouteView, postId?: string, username?: string) => void;
  getCurrentUser: () => BottomNavProps['currentUser'];
}

let bottomNav: BottomNav | null = null;

/** Shared navigation handler for the mobile bottom bar. */
function handleBottomNavNavigate(deps: BottomNavDeps, item: string): void {
  if (item === 'home') {
    window.history.pushState({}, '', '/home');
    deps.navigate('timeline');
  } else if (item === 'explore') {
    window.history.pushState({}, '', '/explore');
    deps.navigate('explore');
  } else if (item === 'arcade') {
    window.history.pushState({}, '', '/arcade');
    deps.navigate('arcade');
  } else if (item === 'notifications') {
    window.history.pushState({}, '', '/notifications');
    deps.navigate('notifications');
  } else if (item === 'account') {
    const currentUser = deps.getCurrentUser();
    if (!currentUser) {
      window.history.pushState({}, '', '/login');
      deps.navigate('login');
      return;
    }
    window.history.pushState({}, '', `/profile/${currentUser.username}`);
    deps.navigate('profile', undefined, currentUser.username);
  }
}

/** Create the single global bottom-nav instance once and mount it. */
export async function ensureBottomNav(deps: BottomNavDeps): Promise<BottomNav> {
  if (!bottomNav) {
    bottomNav = await lazyCreateBottomNav({
      activeItem: 'home',
      currentUser: deps.getCurrentUser() || undefined,
      onNavigate: (item: string) => handleBottomNavNavigate(deps, item),
      onSignIn: () => {
        window.history.pushState({}, '', '/login');
        deps.navigate('login');
      },
      onSignUp: () => {
        window.history.pushState({}, '', '/register');
        deps.navigate('register');
      },
    });
    document.body.appendChild(bottomNav.getElement());
  }
  return bottomNav;
}

/** The mounted instance, if created. */
export function getBottomNav(): BottomNav | null {
  return bottomNav;
}
