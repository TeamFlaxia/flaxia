<script lang="ts">
import { page } from '$app/state';
import { renderBreadcrumbJsonLd, renderCollectionPageJsonLd } from '../../lib/seo-jsonld.ts';
// biome-ignore lint/correctness/noUnusedImports: Svelte prop used in markup
import ArcadeView from '../../lib/svelte/ArcadeView.svelte';
import SsrOnly from '../../lib/svelte/SsrOnly.svelte';
import type { PageProps } from './$types';

const SITE_ORIGIN = 'https://flaxia.app';
const META_TITLE = 'Flaxia - Arcade';
const DESCRIPTION = 'Play community-made games on Flaxia Arcade.';
const CANONICAL_URL = `${SITE_ORIGIN}/arcade`;
const OG_IMAGE = `${SITE_ORIGIN}/og-default-v2.png`;

let { data }: PageProps = $props();

const jsonLd = $derived.by(() => {
  const baseUrl = page.url.origin;
  const url = `${baseUrl}/arcade`;
  return [
    renderCollectionPageJsonLd({
      name: 'Flaxia Arcade',
      description: DESCRIPTION,
      url,
      items: data.games.map((game) => ({
        name: game.title,
        url: `${baseUrl}/arcade/${encodeURIComponent(game.postId)}`,
      })),
    }),
    renderBreadcrumbJsonLd(
      [
        { label: 'Home', url: `${baseUrl}/home` },
        { label: 'Arcade', url },
      ],
      baseUrl,
    ),
  ].join('\n');
});
</script>

<svelte:head>
  {#if jsonLd}{@html jsonLd}{/if}
  <meta name="description" content={DESCRIPTION} />
  <meta property="og:title" content={META_TITLE} />
  <meta property="og:description" content={DESCRIPTION} />
  <meta property="og:url" content={CANONICAL_URL} />
  <meta property="og:image" content={OG_IMAGE} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={META_TITLE} />
  <meta name="twitter:description" content={DESCRIPTION} />
  <meta name="twitter:image" content={OG_IMAGE} />
  <link rel="canonical" href={CANONICAL_URL} />
</svelte:head>

<ArcadeView />
<SsrOnly>
  <section class="ssr-feed" aria-label="Arcade games">
    <h1>Arcade</h1>
    {#each data.games as game (game.postId)}
      <article class="ssr-post">
        <h2><a href={`/arcade/${game.postId}`}>{game.title || 'Game'}</a></h2>
        {#if game.username}<p>@{game.username}</p>{/if}
        {#if game.thumbnailKey}
          <img class="ssr-post__media" src={`/api/thumbnail/${game.postId}`} alt="" loading="lazy" />
        {/if}
      </article>
    {/each}
  </section>
</SsrOnly>
