// Auth guard decisions (split out of main.ts).
//
// Pure functions: which routes guests may see, and where to redirect
// unauthenticated users. The session check (checkAuth) and the actual
// navigation stay in main.ts.
import type { RouteView } from './router.js';

/** Public routes that don't require authentication. */
export function isPublicRoute(pathname: string): boolean {
  const cleanPath = pathname.replace(/\/$/, '');
  return (
    cleanPath === '' ||
    cleanPath === '/' ||
    cleanPath === '/home' ||
    cleanPath === '/explore' ||
    cleanPath === '/search' ||
    cleanPath === '/arcade' ||
    cleanPath === '/login' ||
    cleanPath === '/register' ||
    cleanPath === '/terms' ||
    cleanPath === '/privacy' ||
    cleanPath === '/about' ||
    cleanPath === '/docs' ||
    cleanPath.startsWith('/docs/') ||
    cleanPath.startsWith('/users/') ||
    cleanPath.startsWith('/profile/') ||
    cleanPath.startsWith('/arcade/') ||
    cleanPath.startsWith('/thread/')
  );
}

export interface AuthRedirect {
  path: string;
  view: RouteView;
}

/**
 * Where to redirect the user, or null when the route is allowed.
 * Guests on /notifications go to arcade; all other protected routes go
 * to login. replaceState (not pushState) avoids a back-button redirect loop.
 */
export function resolveAuthRedirect(pathname: string, isAuthenticated: boolean): AuthRedirect | null {
  if (isPublicRoute(pathname)) return null;

  const cleanPath = pathname.replace(/\/$/, '');
  if (cleanPath === '/notifications' && !isAuthenticated) {
    return { path: '/arcade', view: 'arcade' };
  }
  if (!isAuthenticated) {
    return { path: '/login', view: 'login' };
  }
  return null;
}
