// Shared LeftNav callbacks (split out of main.ts).
//
// Passed to every lazyCreateLeftNav call. Navigation and the current user
// come from the bootstrap via deps so this module stays decoupled from
// the app shell.
import type { RouteView } from './router.js';

export interface LeftNavDeps {
  navigate: (view: RouteView, postId?: string, username?: string) => void;
  getCurrentUsername: () => string | null;
}

export interface LeftNavHandlers {
  onNavigate: (item: string) => void;
  onSignIn: () => void;
  onSignUp: () => void;
}

export function leftNavCallbacks(deps: LeftNavDeps): LeftNavHandlers {
  return {
    onNavigate: (item: string): void => {
      // The SvelteKit router owns the URL; the deps callback performs goto().
      if (item === 'home') {
        deps.navigate('timeline');
      } else if (item === 'profile') {
        const username = deps.getCurrentUsername();
        if (!username) {
          deps.navigate('arcade');
          return;
        }
        deps.navigate('profile', undefined, username);
      } else {
        deps.navigate(item as never);
      }
    },
    onSignIn: (): void => {
      deps.navigate('login');
    },
    onSignUp: (): void => {
      deps.navigate('register');
    },
  };
}
