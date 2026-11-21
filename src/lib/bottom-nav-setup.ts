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
  /** Tab id for the current route, so the bar starts on the right item. */
  getActiveItem?: () => string;
}

let bottomNav: BottomNav | null = null;

/** Shared navigation handler for the mobile bottom bar. */
function handleBottomNavNavigate(deps: BottomNavDeps, item: string): void {
  if (item === 'home') {
    deps.navigate('timeline');
  } else if (item === 'account') {
    const currentUser = deps.getCurrentUser();
    if (!currentUser) {
      deps.navigate('login');
      return;
    }
    deps.navigate('profile', undefined, currentUser.username);
  } else {
    deps.navigate(item as never);
  }
}

/** Create the single global bottom-nav instance once and mount it. */
export async function ensureBottomNav(deps: BottomNavDeps): Promise<BottomNav> {
  if (!bottomNav) {
    bottomNav = await lazyCreateBottomNav({
      activeItem: deps.getActiveItem?.() || 'home',
      currentUser: deps.getCurrentUser() || undefined,
      onNavigate: (item: string) => handleBottomNavNavigate(deps, item),
      onSignIn: () => {
        deps.navigate('login');
      },
      onSignUp: () => {
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
