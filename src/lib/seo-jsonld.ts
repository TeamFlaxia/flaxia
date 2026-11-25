// Crawler-facing schema.org metadata for SvelteKit SSR. Every block is an
// `application/ld+json` script produced by renderJsonLd, which escapes `<`,
// `>`, `&` and U+2028/9 so user-controlled text can never close the element.
import {
  type PostRow,
  renderBlogPostingJsonLd,
  renderJsonLd,
  renderPersonJsonLd,
  renderWebSiteJsonLd,
  type UserRow,
} from '../../functions/lib/render-html.ts';
import type { Post } from '../../shared/types/post.ts';

export type { PostRow, UserRow };
export { renderBlogPostingJsonLd, renderPersonJsonLd, renderWebSiteJsonLd };

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
    hashtags: post.hashtags ?? '',
    parent_id: post.parent_id ?? null,
    root_id: post.root_id ?? null,
  } as PostRow;
}
