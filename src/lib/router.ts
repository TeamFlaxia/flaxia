// URL → route parsing (split out of main.ts).
//
// Pure function of (pathname, search): no app state, fully unit-testable.
// parseCurrentRoute() is the thin window.location wrapper used by the bootstrap.
export type RouteView =
  | 'timeline'
  | 'thread'
  | 'login'
  | 'register'
  | 'profile'
  | 'explore'
  | 'search'
  | 'translate'
  | 'notifications'
  | 'bookmarks'
  | 'terms'
  | 'privacy'
  | 'child-safety'
  | 'about'
  | 'docs'
  | 'admin'
  | 'settings'
  | 'arcade'
  | 'billing-success'
  | 'billing-canceled'
  | 'download'
  | 'mail'
  | 'mail-thread'
  | 'mail-compose'
  | 'mail-settings';

export interface RouteInfo {
  view: RouteView;
  postId: string | null;
  username: string | null;
  tag: string | null;
  adminTab?: 'analytics' | 'alerts' | 'hidden' | 'users' | 'ads' | 'counter';
  searchQuery?: string;
  searchType?: 'posts' | 'users' | 'arcade';
}

export function parseRoute(path: string, search: string): RouteInfo | null {
  // Remove trailing slash and ensure consistent format
  const cleanPath = path.replace(/\/$/, '');

  // Auth routes
  if (cleanPath === '/login') {
    return { view: 'login', postId: null, username: null, tag: null };
  }

  if (cleanPath === '/register') {
    return { view: 'register', postId: null, username: null, tag: null };
  }

  // Legal pages (public)
  if (cleanPath === '/terms') {
    return { view: 'terms', postId: null, username: null, tag: null };
  }

  if (cleanPath === '/privacy') {
    return { view: 'privacy', postId: null, username: null, tag: null };
  }

  if (cleanPath === '/child-safety') {
    return { view: 'child-safety', postId: null, username: null, tag: null };
  }

  if (cleanPath === '/about') {
    return { view: 'about', postId: null, username: null, tag: null };
  }

  // Docs route (blog) - public, no auth required
  const docsMatch = cleanPath.match(/^\/docs\/([^/]+)$/);
  if (docsMatch) {
    return { view: 'docs', postId: decodeURIComponent(docsMatch[1]), username: null, tag: null };
  }

  if (cleanPath === '/docs') {
    return { view: 'docs', postId: null, username: null, tag: null };
  }

  // Explore route - public, no auth required
  const exploreMatch = cleanPath.match(/^\/explore$/);
  if (exploreMatch) {
    const urlParams = new URLSearchParams(search);
    const tag = urlParams.get('tag');
    return { view: 'explore', postId: null, username: null, tag };
  }

  // Search route - public, no auth required
  if (cleanPath === '/search') {
    const urlParams = new URLSearchParams(search);
    const q = urlParams.get('q') || '';
    const type = urlParams.get('type') || 'posts';
    return {
      view: 'search',
      postId: null,
      username: null,
      tag: null,
      searchQuery: q,
      searchType: type as 'posts' | 'users' | 'arcade',
    };
  }

  // Arcade game route - public, no auth required
  const arcadeGameMatch = cleanPath.match(/^\/arcade\/([^/]+)$/);
  if (arcadeGameMatch) {
    return { view: 'arcade', postId: arcadeGameMatch[1], username: null, tag: null };
  }

  // Arcade route - public, no auth required
  if (cleanPath === '/arcade') {
    return { view: 'arcade', postId: null, username: null, tag: null };
  }

  // Thread route (check before profile) - public, no auth required
  const threadMatch = cleanPath.match(/^\/thread\/([^/]+)$/);
  if (threadMatch) {
    return { view: 'thread', postId: threadMatch[1], username: null, tag: null };
  }

  // Profile routes - matches both /users/:username and /profile/:username
  const usersProfileMatch = cleanPath.match(/^\/users\/([^/]+)$/);
  const profileMatch = cleanPath.match(/^\/profile\/([^/]+)$/);

  if (usersProfileMatch?.[1]) {
    return { view: 'profile', postId: null, username: usersProfileMatch[1], tag: null };
  }

  if (profileMatch?.[1]) {
    return { view: 'profile', postId: null, username: profileMatch[1], tag: null };
  }

  // Notifications route - requires auth
  if (cleanPath === '/notifications') {
    return { view: 'notifications', postId: null, username: null, tag: null };
  }

  // Bookmarks route - requires auth
  if (cleanPath === '/bookmarks') {
    return { view: 'bookmarks', postId: null, username: null, tag: null };
  }

  // Settings route - requires auth
  if (cleanPath === '/settings') {
    return { view: 'settings', postId: null, username: null, tag: null };
  }

  // Mail routes - requires auth (docs/mail.md §10)
  if (cleanPath === '/mail') {
    return { view: 'mail', postId: null, username: null, tag: null };
  }
  const mailThreadMatch = cleanPath.match(/^\/mail\/thread\/([^/]+)$/);
  if (mailThreadMatch) {
    return { view: 'mail-thread', postId: mailThreadMatch[1], username: null, tag: null };
  }
  if (cleanPath === '/mail/compose') {
    return { view: 'mail-compose', postId: null, username: null, tag: null };
  }
  if (cleanPath === '/mail/settings') {
    return { view: 'mail-settings', postId: null, username: null, tag: null };
  }

  // Billing routes
  if (cleanPath === '/billing/success') {
    return { view: 'billing-success', postId: null, username: null, tag: null };
  }
  if (cleanPath === '/billing/canceled') {
    return { view: 'billing-canceled', postId: null, username: null, tag: null };
  }

  // App download page - public, no auth required
  if (cleanPath === '/download') {
    return { view: 'download', postId: null, username: null, tag: null };
  }

  // Translation page - public, no auth required
  if (cleanPath === '/translate') {
    return { view: 'translate', postId: null, username: null, tag: null };
  }

  // Sandbox route - public, no auth required
  const sandboxMatch = cleanPath.match(/^\/sandbox\/post\/([^/]+)$/);
  if (sandboxMatch) {
    // For sandbox, don't initialize the app - let the sandbox page handle itself
    return null;
  }

  // Admin route - requires auth
  const adminMatch = cleanPath.match(/^\/admin(\/analytics|\/ads|\/alerts|\/hidden|\/users|\/counter)?$/);
  if (adminMatch) {
    const tab = adminMatch[1]
      ? (adminMatch[1].replace('/', '') as 'analytics' | 'alerts' | 'hidden' | 'users' | 'ads' | 'counter')
      : 'alerts';
    return { view: 'admin', postId: null, username: null, tag: null, adminTab: tab };
  }

  // Home route - public, no auth required
  if (cleanPath === '/home') {
    return { view: 'timeline', postId: null, username: null, tag: null };
  }

  // Default timeline (only for root path) - public, no auth required
  if (cleanPath === '' || cleanPath === '/') {
    return { view: 'timeline', postId: null, username: null, tag: null };
  }

  // If no route matched, default to timeline
  return { view: 'timeline', postId: null, username: null, tag: null };
}

/** Parse the browser's current URL (bootstrap wrapper around parseRoute). */
export function parseCurrentRoute(): RouteInfo | null {
  return parseRoute(window.location.pathname, window.location.search);
}
