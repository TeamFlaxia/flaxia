// View → bottom-nav item mapping (split out of main.ts).
//
// Pure function: which bottom-bar tab is active for a given router view.
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
    default:
      return '';
  }
}
