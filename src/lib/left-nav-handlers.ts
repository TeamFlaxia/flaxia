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

export function createLeftNavHandlers(deps: LeftNavDeps): LeftNavHandlers {
  return {
    onNavigate: (item: string): void => {
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
      } else if (item === 'bookmarks') {
        window.history.pushState({}, '', '/bookmarks');
        deps.navigate('bookmarks');
      } else if (item === 'settings') {
        window.history.pushState({}, '', '/settings');
        deps.navigate('settings');
      } else if (item === 'profile') {
        const username = deps.getCurrentUsername();
        if (!username) {
          window.history.pushState({}, '', '/arcade');
          deps.navigate('arcade');
          return;
        }
        window.history.pushState({}, '', `/profile/${username}`);
        deps.navigate('profile', undefined, username);
      }
    },
    onSignIn: (): void => {
      window.history.pushState({}, '', '/login');
      deps.navigate('login');
    },
    onSignUp: (): void => {
      window.history.pushState({}, '', '/register');
      deps.navigate('register');
    },
  };
}
