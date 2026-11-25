import { buildDocsIndexContent, fetchDocsManifest } from '../../lib/docs/ssr-content.ts';
import { getLocale, t } from '../../lib/i18n.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent }) => {
  // A universal load re-runs on hydration: `data` here is parent layout data,
  // never this page's previous result. SvelteKit replays the serialized SSR
  // fetches, and `parent()` waits for the root layout's i18n bootstrap so the
  // locale matches the server render.
  await parent();
  const manifest = await fetchDocsManifest(fetch);
  return buildDocsIndexContent(manifest, getLocale(), t('docs.title'));
};
