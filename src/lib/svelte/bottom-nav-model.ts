// Pure data for the mobile bottom navigation. The Svelte component renders it;
// keeping the tab table here makes the order and icon names explicit.
import type { IconName } from '../icons.ts';

export interface BottomNavItem {
  id: string;
  labelKey: string;
  iconName: IconName;
}

export const BOTTOM_NAV_ITEMS = [
  { id: 'home', labelKey: 'nav.home', iconName: 'home' },
  { id: 'explore', labelKey: 'nav.explore', iconName: 'search' },
  { id: 'arcade', labelKey: 'nav.arcade', iconName: 'game' },
  { id: 'notifications', labelKey: 'nav.notifications', iconName: 'notifications' },
] as const satisfies readonly BottomNavItem[];

const AVATAR_KEY = /^avatar\/[A-Za-z0-9_-]{1,128}$/;

/**
 * The avatar image is a server-minted key. Reject anything that could escape
 * the key shape before it is interpolated into a CSS `url()`.
 */
export function bottomNavAvatarKey(avatarKey?: string | null): string | null {
  return avatarKey && AVATAR_KEY.test(avatarKey) ? avatarKey : null;
}

/** First grapheme, upper-cased; the text fallback for a missing avatar. */
export function bottomNavInitial(name?: string | null): string {
  return Array.from(name || '?')[0]?.toUpperCase() ?? '?';
}
