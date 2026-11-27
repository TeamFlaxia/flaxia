// Crawler-facing schema.org metadata shared by the Pages Functions renderer and
// the SvelteKit app. This module is platform-neutral: it depends only on other
// shared/ modules and on minimal structural interfaces, never on functions/ or
// src/. Keeping the serializer here lets both sides emit the same escaped
// `application/ld+json` blocks without crossing the server -> client boundary.
import { stripPostColors } from './post-colors.ts';

/** Only the post fields the BlogPosting serializer reads. */
export interface SeoPost {
  text: string;
  game_description?: string | null;
  game_title?: string | null;
  created_at: string;
}

/** Only the profile fields the Person serializer reads. */
export interface SeoUser {
  display_name: string;
  username: string;
  bio: string;
}

export function renderJsonLd(data: Record<string, unknown>): string {
  // JSON.stringify does not escape `<`, so a value containing `</script>`
  // closes the script element and turns the rest of the JSON into markup
  // (stored XSS in every SSR page that embeds user data). Escaping the HTML
  // metacharacters — and U+2028/U+2029, which are valid JSON but invalid in
  // JavaScript string literals — keeps the payload inert inside the element.
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<script type="application/ld+json">${json}</script>`;
}

export function renderBlogPostingJsonLd(
  post: SeoPost,
  authorName: string,
  authorUrl: string,
  postUrl: string,
  description?: string,
  image?: string,
  headline?: string,
): string {
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    // The headline is the post/game title (or a content excerpt), never just
    // the author name — schema.org treats it as the article's title.
    headline:
      headline ||
      description ||
      stripPostColors(post.text).split('\n')[0].trim().slice(0, 110) ||
      `${authorName} on Flaxia`,
    description: description || post.game_description || stripPostColors(post.text).slice(0, 200),
    image: image || undefined,
    url: postUrl,
    datePublished: post.created_at,
    author: {
      '@type': 'Person',
      name: authorName,
      url: authorUrl,
    },
  });
}

export function renderPersonJsonLd(user: SeoUser, profileUrl: string): string {
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: user.display_name,
    alternateName: `@${user.username}`,
    description: user.bio ? user.bio.slice(0, 200) : undefined,
    url: profileUrl,
  });
}

export function renderWebSiteJsonLd(siteName: string, url: string): string {
  return renderJsonLd({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteName,
    url,
  });
}
