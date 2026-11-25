import { error } from '@sveltejs/kit';
import { buildDocsArticleContent, fetchDocsManifest, findDoc, preferredFile } from '../../../lib/docs/ssr-content.ts';
import { getLocale } from '../../../lib/i18n.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, parent }) => {
  // A universal load re-runs on hydration: `data` is the parent layout's data,
  // not the page's own previous result. SvelteKit replays serialized SSR
  // fetches, so the same fetch calls produce the same data as the server.
  await parent();

  const { slug } = params;
  if (!slug) throw error(404, 'Document not found');
  const manifest = await fetchDocsManifest(fetch);
  const doc = findDoc(manifest, slug);
  if (!doc) throw error(404, 'Document not found');
  const locale = getLocale();
  const file = preferredFile(doc, locale);
  if (!file) throw error(404, 'Document not found');

  const response = await fetch(`/docs/${encodeURIComponent(file)}`);
  if (!response.ok) throw error(404, 'Document not found');
  return buildDocsArticleContent(slug, doc, locale, await response.text());
};
