// App-side adapter for crawler-facing schema.org metadata. The canonical
// serializers live in shared/seo-jsonld.ts so the Pages Functions renderer can
// use them without importing browser code from src/. This module keeps the
// public API the Svelte routes already import unchanged.

import type { PostRow } from '../../functions/lib/render-html.ts';
import {
  renderBlogPostingJsonLd,
  renderJsonLd,
  renderPersonJsonLd,
  renderWebSiteJsonLd,
} from '../../shared/seo-jsonld.ts';
import type { Post } from '../../shared/types/post.ts';

export type { PostRow, UserRow } from '../../functions/lib/render-html.ts';
export { renderBlogPostingJsonLd, renderJsonLd, renderPersonJsonLd, renderWebSiteJsonLd };

/** Single production origin for canonical, og:url and every JSON-LD URL. */
export const SEO_ORIGIN = 'https://flaxia.app';

export interface BreadcrumbItem {
  label: string;
  url: string;
}

/** Ported from the deleted functions/lib/ssr-layout.ts, still using renderJsonLd. */
export function renderBreadcrumbJsonLd(items: BreadcrumbItem[], baseUrl: string): string {
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.label,
      item: item.url.startsWith('http') ? item.url : `${baseUrl}${item.url}`,
    })),
  });
}

export interface CollectionPageItem {
  name?: string;
  url: string;
}

/** CollectionPage for the arcade index (and, as a fallback, a single game). */
export function renderCollectionPageJsonLd(options: {
  name: string;
  description: string;
  url: string;
  items?: CollectionPageItem[];
}): string {
  const { name, description, url, items = [] } = options;
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    description,
    url,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        url: item.url,
      })),
    },
  });
}

/** Adapt the API's Post shape to the renderer's stricter PostRow shape. */
export function asSeoPostRow(post: Post): PostRow {
  return {
    ...post,
    display_name: post.display_name ?? null,
    avatar_key: post.avatar_key ?? null,
    gif_key: post.gif_key ?? null,
    payload_key: post.payload_key ?? null,
    swf_key: post.swf_key ?? null,
    thumbnail_key: post.thumbnail_key ?? null,
    // The thread endpoint returns this game-specific column; keep it on the
    // SEO row even though the shared Post type does not declare it yet.
    game_description: (post as Post & { game_description?: string | null }).game_description ?? null,
    hashtags: post.hashtags ?? '',
    parent_id: post.parent_id ?? null,
    root_id: post.root_id ?? null,
  } as PostRow;
}
