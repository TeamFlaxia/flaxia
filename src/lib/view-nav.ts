// View → bottom-nav item mapping (split out of main.ts).
//
// Pure function: which bottom-bar tab is active for a given router view.
//
// Views that live only in the drawer or behind a detail link (Maps, Translate,
// Mail, Admin, Docs, Download, legal pages) return '' so the bar clears its
// highlight instead of keeping whatever tab the user came from.
export function viewToBottomNavId(view: string): string {
  switch (view) {
    case 'timeline':
    case 'thread':
      return 'home';
    case 'explore':
    case 'search':
      return 'explore';
    case 'arcade':
      return 'arcade';
    case 'profile':
    case 'settings':
    case 'bookmarks':
      return 'account';
    case 'notifications':
      return 'notifications';
    // Detail/drawer-only surfaces: no bottom tab owns them, so the bar must
    // clear (returning '' here is what prevents a stale "Arcade" highlight).
    case 'maps':
    case 'translate':
    case 'mail':
    case 'mail-thread':
    case 'mail-compose':
    case 'mail-settings':
    case 'admin':
    case 'docs':
    case 'legal':
    case 'download':
    case 'login':
    case 'register':
    default:
      return '';
  }
}

/** Map a router view to the in-app URL used by SPA navigation. */
export function viewToPath(view: string, postId?: string, username?: string): string {
  if (view === 'timeline') return '/home';
  if (view === 'profile') return username ? `/profile/${username}` : '/home';
  if (view === 'thread' && postId) return `/thread/${postId}`;
  if (view === 'arcade' && postId) return `/arcade/${postId}`;
  return `/${view}`;
}
