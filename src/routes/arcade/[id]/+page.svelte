<script lang="ts">
import { page } from '$app/state';
import { stripPostColors } from '../../../../shared/post-colors.ts';
// biome-ignore lint/correctness/noUnusedImports: Svelte prop used in markup
import ArcadeView from '../../../lib/svelte/ArcadeView.svelte';
import SsrOnly from '../../../lib/svelte/SsrOnly.svelte';
import SsrPostList from '../../../lib/svelte/SsrPostList.svelte';
import type { PageProps } from './$types';

const SITE_ORIGIN = 'https://flaxia.app';
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og-default-v2.png`;

let { data }: PageProps = $props();

const ssrPosts = $derived(data.post ? [data.post, ...data.replies] : []);
const gameTitle = $derived(
  data.game?.title ||
    (data.post ? stripPostColors(data.post.text) : '').replace(/\s+/g, ' ').trim().slice(0, 120) ||
    'Game',
);
const metaTitle = $derived(`Flaxia Arcade - ${gameTitle}`);
const description = $derived(`${gameTitle} - play this game on Flaxia Arcade.`);
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
</script>

<svelte:head>
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
