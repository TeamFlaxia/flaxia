// Document title per route. The SPA owns one <title> in the root layout; the
// static index.html title would otherwise stay "Flaxia" on every page.
import { t } from './i18n.ts';

const TITLES: Array<[RegExp, () => string]> = [
  [/^\/$|^\/home\/?$/, () => ''],
  [/^\/explore/, () => t('nav.explore')],
  [/^\/federated/, () => t('federated.title')],
  [/^\/search/, () => t('page_title.search')],
  [/^\/arcade/, () => t('nav.arcade')],
  [/^\/thread\//, () => t('thread.title')],
  [/^\/notifications/, () => t('nav.notifications')],
  [/^\/bookmarks/, () => t('nav.bookmarks')],
  [/^\/settings/, () => t('nav.settings')],
  [/^\/mail/, () => t('mail.title')],
  [/^\/maps/, () => t('nav.maps')],
  [/^\/translate/, () => t('nav.translate')],
  [/^\/docs/, () => t('docs.title')],
  [/^\/about/, () => t('legal.about_title')],
  [/^\/terms/, () => t('legal.terms_title')],
  [/^\/privacy/, () => t('legal.privacy_title')],
  [/^\/child-safety/, () => t('legal.child_safety_title')],
  [/^\/download/, () => t('app_download.title')],
  [/^\/admin/, () => t('page_title.admin')],
  [/^\/billing\//, () => t('page_title.billing')],
  [/^\/login/, () => t('nav.login')],
  [/^\/register/, () => t('nav.register')],
];

function profileLabel(pathname: string): string | null {
  // A remote handle is only unique together with its instance, so the title
  // has to include both parts. Local profiles keep their existing label.
  const remote = pathname.match(/^\/@([^/]+)\/([^/]+)/);
  if (remote?.[1] && remote[2]) {
    try {
      return `${t('remote_profile.title')} · @${decodeURIComponent(remote[2])}@${decodeURIComponent(remote[1])}`;
    } catch {
      return t('remote_profile.title');
    }
  }
  const match = pathname.match(/^\/(?:profile|users)\/([^/]+)/);
  if (!match?.[1]) return null;
  try {
    return `${t('nav.profile')} · @${decodeURIComponent(match[1])}`;
  } catch {
    return t('nav.profile');
  }
}

export function pageTitle(pathname: string): string {
  const profile = profileLabel(pathname);
  if (profile) return `Flaxia - ${profile}`;
  for (const [pattern, label] of TITLES) {
    if (!pattern.test(pathname)) continue;
    const text = label();
    return text ? `Flaxia - ${text}` : 'Flaxia';
  }
  return 'Flaxia';
}

/**
 * Route-specific meta description. The root layout supplies the generic site
 * description for every other route; a route that owns its description uses
 * this helper in its own <svelte:head> (SvelteKit keeps the last meta tag with
 * the same name). Remote profiles deliberately keep the generic description.
 */
export function pageDescription(pathname: string): string {
  if (/^\/federated\/?$/.test(pathname)) return t('federated.subtitle');
  return t('site.description');
}
