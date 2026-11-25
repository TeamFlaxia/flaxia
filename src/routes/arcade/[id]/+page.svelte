<script lang="ts">
import { page } from '$app/state';
import { stripPostColors } from '../../../../shared/post-colors.ts';
import { buildGameDescription, buildGameTitle } from '../../../lib/game-seo.ts';
import {
  asSeoPostRow,
  renderBlogPostingJsonLd,
  renderBreadcrumbJsonLd,
  renderCollectionPageJsonLd,
} from '../../../lib/seo-jsonld.ts';
// biome-ignore lint/correctness/noUnusedImports: Svelte prop used in markup
import ArcadeView from '../../../lib/svelte/ArcadeView.svelte';
import SsrOnly from '../../../lib/svelte/SsrOnly.svelte';
import SsrPostList from '../../../lib/svelte/SsrPostList.svelte';
import type { PageProps } from './$types';

const SITE_ORIGIN = 'https://flaxia.app';
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og-default-v2.png`;

let { data }: PageProps = $props();

const ssrPosts = $derived(data.post ? [data.post, ...data.replies] : []);
const plainText = $derived(data.post ? stripPostColors(data.post.text) : '');
const gameTitle = $derived(plainText ? buildGameTitle(plainText) : data.game?.title || 'Game');
const authorName = $derived(data.game?.username || data.post?.username || '');
const metaTitle = $derived(`Flaxia Arcade - ${gameTitle}`);
const description = $derived(
  buildGameDescription({
    gameDescription: (data.post as { game_description?: string | null } | null)?.game_description,
    title: gameTitle,
    typeLabel: data.post?.swf_key ? 'Flash' : 'HTML5',
    authorName: authorName || 'Flaxia',
    text: plainText,
  }),
);
const canonicalUrl = $derived(
  page.params.id ? `${SITE_ORIGIN}/arcade/${encodeURIComponent(page.params.id)}` : page.url.href,
);
const ogImage = $derived.by(() => {
  const key = data.game?.thumbnailKey || data.post?.thumbnail_key;
  if (key) return `${SITE_ORIGIN}/api/images/${encodeURIComponent(key)}`;
  const gifKey = data.post?.gif_key;
  if (gifKey && !/^(audio|video)\//.test(gifKey)) {
    return `${SITE_ORIGIN}/api/images/${encodeURIComponent(gifKey)}`;
  }
  return DEFAULT_OG_IMAGE;
});

const jsonLd = $derived.by(() => {
  const url = canonicalUrl;
  const breadcrumb = renderBreadcrumbJsonLd(
    [
      { label: 'Home', url: `${SITE_ORIGIN}/home` },
      { label: 'Arcade', url: `${SITE_ORIGIN}/arcade` },
      { label: gameTitle, url },
    ],
    SITE_ORIGIN,
  );
  const content = data.post
    ? renderBlogPostingJsonLd(
        asSeoPostRow(data.post),
        authorName,
        authorName ? `${SITE_ORIGIN}/users/${encodeURIComponent(authorName)}` : url,
        url,
        description,
        ogImage,
        gameTitle,
      )
    : renderCollectionPageJsonLd({ name: gameTitle, description, url });
  return [content, breadcrumb].join('\n');
});
</script>

<svelte:head>
  <title>{metaTitle}</title>
  {#if jsonLd}{@html jsonLd}{/if}
  <meta name="description" content={description} />
  <meta property="og:title" content={metaTitle} />
  <meta property="og:description" content={description} />
  <meta property="og:url" content={canonicalUrl} />
  <meta property="og:image" content={ogImage} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={metaTitle} />
  <meta name="twitter:description" content={description} />
  <meta name="twitter:image" content={ogImage} />
  <link rel="canonical" href={canonicalUrl} />
</svelte:head>

{#key page.params.id}
  <ArcadeView gameId={page.params.id} />
  <SsrOnly>
    <section class="ssr-feed" aria-label="Game">
      <h1>{data.game?.title || 'Game'}</h1>
      {#if data.game?.username}<p>@{data.game.username}</p>{/if}
    </section>
  </SsrOnly>
  <SsrPostList posts={ssrPosts} label="Game post" />
{/key}
