import { error } from '@sveltejs/kit';
import {
  buildDocsArticleContent,
  type DocsPageContent,
  fetchDocsManifest,
  findDoc,
  preferredFile,
} from '../../../lib/docs/ssr-content.ts';
import { getLocale } from '../../../lib/i18n.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ data, fetch, params, parent }) => {
  // Prefer the serialized server result on hydration (see /docs/+page.ts).
  if (data && 'kind' in data) return data as DocsPageContent;
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
