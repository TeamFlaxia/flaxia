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
  | 'billing-canceled';

export interface RouteInfo {
  view: RouteView;
  postId: string | null;
  username: string | null;
  tag: string | null;
  adminTab?: 'alerts' | 'hidden' | 'users' | 'counter';
  searchQuery?: string;
  searchType?: 'posts' | 'users' | 'arcade';
}

export function parseRoute(path: string, search: string): RouteInfo | null {
  console.log('Current path:', path);

  // Remove trailing slash and ensure consistent format
  const cleanPath = path.replace(/\/$/, '');
  console.log('Clean path:', cleanPath);

  // Auth routes
  if (cleanPath === '/login') {
    console.log('Login route detected');
    return { view: 'login', postId: null, username: null, tag: null };
  }

  if (cleanPath === '/register') {
    console.log('Register route detected');
    return { view: 'register', postId: null, username: null, tag: null };
  }

  // Legal pages (public)
  if (cleanPath === '/terms') {
    console.log('Terms route detected');
    return { view: 'terms', postId: null, username: null, tag: null };
  }

  if (cleanPath === '/privacy') {
    console.log('Privacy route detected');
    return { view: 'privacy', postId: null, username: null, tag: null };
  }

  if (cleanPath === '/child-safety') {
    return { view: 'child-safety', postId: null, username: null, tag: null };
  }

  if (cleanPath === '/about') {
    console.log('About route detected');
    return { view: 'about', postId: null, username: null, tag: null };
  }

  // Docs route (blog) - public, no auth required
  const docsMatch = cleanPath.match(/^\/docs\/([^/]+)$/);
  if (docsMatch) {
    console.log('Docs article route detected, slug:', docsMatch[1]);
    return { view: 'docs', postId: decodeURIComponent(docsMatch[1]), username: null, tag: null };
  }

  if (cleanPath === '/docs') {
    console.log('Docs route detected');
    return { view: 'docs', postId: null, username: null, tag: null };
  }

  // Explore route - public, no auth required
  const exploreMatch = cleanPath.match(/^\/explore$/);
  if (exploreMatch) {
    const urlParams = new URLSearchParams(search);
    const tag = urlParams.get('tag');
    console.log('Explore route detected, tag:', tag);
    return { view: 'explore', postId: null, username: null, tag };
  }

  // Search route - public, no auth required
  if (cleanPath === '/search') {
    const urlParams = new URLSearchParams(search);
    const q = urlParams.get('q') || '';
    const type = urlParams.get('type') || 'posts';
    console.log('Search route detected, query:', q, 'type:', type);
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
    console.log('Arcade game route detected, gameId:', arcadeGameMatch[1]);
    return { view: 'arcade', postId: arcadeGameMatch[1], username: null, tag: null };
  }

  // Arcade route - public, no auth required
  if (cleanPath === '/arcade') {
    console.log('Arcade route detected');
    return { view: 'arcade', postId: null, username: null, tag: null };
  }

  // Thread route (check before profile) - public, no auth required
  const threadMatch = cleanPath.match(/^\/thread\/([^/]+)$/);
  if (threadMatch) {
    console.log('Thread route detected, postId:', threadMatch[1]);
    return { view: 'thread', postId: threadMatch[1], username: null, tag: null };
  }

  // Profile routes - matches both /users/:username and /profile/:username
  const usersProfileMatch = cleanPath.match(/^\/users\/([^/]+)$/);
  const profileMatch = cleanPath.match(/^\/profile\/([^/]+)$/);
  console.log('Profile match test:', { usersProfileMatch, profileMatch }, 'cleanPath:', cleanPath);

  if (usersProfileMatch?.[1]) {
    console.log('Users profile route detected, username:', usersProfileMatch[1]);
    return { view: 'profile', postId: null, username: usersProfileMatch[1], tag: null };
  }

  if (profileMatch?.[1]) {
    console.log('Profile route detected, username:', profileMatch[1]);
    return { view: 'profile', postId: null, username: profileMatch[1], tag: null };
  }

  // Notifications route - requires auth
  if (cleanPath === '/notifications') {
    console.log('Notifications route detected');
    return { view: 'notifications', postId: null, username: null, tag: null };
  }

  // Bookmarks route - requires auth
  if (cleanPath === '/bookmarks') {
    console.log('Bookmarks route detected');
    return { view: 'bookmarks', postId: null, username: null, tag: null };
  }

  // Settings route - requires auth
  if (cleanPath === '/settings') {
    console.log('Settings route detected');
    return { view: 'settings', postId: null, username: null, tag: null };
  }

  // Billing routes
  if (cleanPath === '/billing/success') {
    console.log('Billing success route detected');
    return { view: 'billing-success', postId: null, username: null, tag: null };
  }
  if (cleanPath === '/billing/canceled') {
    console.log('Billing canceled route detected');
    return { view: 'billing-canceled', postId: null, username: null, tag: null };
  }

  // Sandbox route - public, no auth required
  const sandboxMatch = cleanPath.match(/^\/sandbox\/post\/([^/]+)$/);
  if (sandboxMatch) {
    console.log('Sandbox route detected, postId:', sandboxMatch[1]);
    // For sandbox, don't initialize the app - let the sandbox page handle itself
    console.log('Sandbox page detected, skipping app initialization');
    return null;
  }

  // Admin route - requires auth
  const adminMatch = cleanPath.match(/^\/admin(\/alerts|\/hidden|\/users|\/counter)?$/);
  if (adminMatch) {
    console.log('Admin route detected');
    const tab = adminMatch[1]
      ? (adminMatch[1].replace('/', '') as 'alerts' | 'hidden' | 'users' | 'counter')
      : 'alerts';
    return { view: 'admin', postId: null, username: null, tag: null, adminTab: tab };
  }

  // Home route - public, no auth required
  if (cleanPath === '/home') {
    console.log('Home route detected');
    return { view: 'timeline', postId: null, username: null, tag: null };
  }

  // Default timeline (only for root path) - public, no auth required
  if (cleanPath === '' || cleanPath === '/') {
    console.log('Timeline route detected');
    return { view: 'timeline', postId: null, username: null, tag: null };
  }

  // If no route matched, default to timeline
  console.log('Unknown route, defaulting to timeline');
  return { view: 'timeline', postId: null, username: null, tag: null };
}

/** Parse the browser's current URL (bootstrap wrapper around parseRoute). */
export function parseCurrentRoute(): RouteInfo | null {
  return parseRoute(window.location.pathname, window.location.search);
}
