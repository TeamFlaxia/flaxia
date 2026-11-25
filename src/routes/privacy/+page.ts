import { error } from '@sveltejs/kit';
import { buildLegalContent, fetchLegalMarkdownForLoad } from '../../lib/docs/ssr-content.ts';
import { getLocale, t } from '../../lib/i18n.ts';
import { LEGAL_PAGES } from '../../lib/legal/pages.ts';
import type { PageLoad } from './$types';

const PAGE = LEGAL_PAGES.privacy;

export const load: PageLoad = async ({ fetch, parent }) => {
  // A universal load re-runs on hydration: `data` is the parent layout's data,
  // never this page's own result. SvelteKit replays the serialized SSR fetches;
  // `parent()` waits for the root layout's i18n bootstrap to keep the locale
  // identical to the server render.
  await parent();
  const locale = getLocale();
  let markdown: string;
  try {
    markdown = await fetchLegalMarkdownForLoad(fetch, PAGE.fileName, locale);
  } catch {
    try {
      markdown = await fetchLegalMarkdownForLoad(fetch, PAGE.fileName, 'en');
    } catch {
      throw error(404, 'Page not found');
    }
  }
  return buildLegalContent('privacy', locale, markdown, t(PAGE.titleKey));
};
