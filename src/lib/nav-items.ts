// Primary navigation model.
//
// Shared by the Svelte LeftNav so guest and signed-in navigation cannot drift.
// deliberately limited to the public sections: Maps and Translate are account
// features and are not advertised to logged-out visitors.
import type { IconName } from './icons.js';

export interface NavItemDef {
  id: string;
  /** Locale key; the caller resolves it so this module stays DOM/i18n-free. */
  labelKey: string;
  icon: IconName;
}

export function navItemsFor(signedIn: boolean): NavItemDef[] {
  const items: NavItemDef[] = [
    { id: 'home', labelKey: 'nav.home', icon: 'home' },
    { id: 'explore', labelKey: 'nav.explore', icon: 'explore' },
    { id: 'arcade', labelKey: 'nav.arcade', icon: 'arcade' },
  ];

  if (signedIn) {
    items.push(
      { id: 'notifications', labelKey: 'nav.notifications', icon: 'notifications' },
      { id: 'bookmarks', labelKey: 'nav.bookmarks', icon: 'bookmark' },
    );
  }

  return items;
}

/** Sections that are account-only and must never appear in the guest rail. */
export const ACCOUNT_ONLY_NAV_IDS = ['maps', 'translate', 'notifications', 'bookmarks'] as const;
