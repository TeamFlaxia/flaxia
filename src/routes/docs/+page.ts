import { buildDocsIndexContent, type DocsPageContent, fetchDocsManifest } from '../../lib/docs/ssr-content.ts';
import { getLocale, t } from '../../lib/i18n.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ data, fetch, parent }) => {
  // A server load's data is serialized into the SSR document and replayed on
  // hydration; prefer it when present. Universal-only loads re-run on the
  // client, so below we use SvelteKit's fetch (same URLs) and wait for the root
  // layout's i18n bootstrap to keep the locale identical to SSR.
  if (data && 'kind' in data) return data as DocsPageContent;
  await parent();
  const manifest = await fetchDocsManifest(fetch);
  return buildDocsIndexContent(manifest, getLocale(), t('docs.title'));
};
