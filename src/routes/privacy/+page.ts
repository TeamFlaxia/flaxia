import { error } from '@sveltejs/kit';
import { buildLegalContent, fetchLegalMarkdownForLoad, type LegalArticleContent } from '../../lib/docs/ssr-content.ts';
import { getLocale, t } from '../../lib/i18n.ts';
import { LEGAL_PAGES } from '../../lib/legal/pages.ts';
import type { PageLoad } from './$types';

const PAGE = LEGAL_PAGES.privacy;

export const load: PageLoad = async ({ data, fetch, parent }) => {
  // Prefer the serialized server result on hydration; universal loads re-run
  // on the client, so wait for the root layout's i18n bootstrap first.
  if (data && 'canonical' in data) return data as LegalArticleContent;
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
