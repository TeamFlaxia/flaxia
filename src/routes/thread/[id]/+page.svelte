<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import { stripPostColors } from '../../../../shared/post-colors.ts';
import { navigate } from '../../../lib/navigation.ts';
import { asSeoPostRow, renderBlogPostingJsonLd, renderBreadcrumbJsonLd } from '../../../lib/seo-jsonld.ts';
import SsrPostList from '../../../lib/svelte/SsrPostList.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';
import ThreadPage from '../../../lib/svelte/ThreadPage.svelte';
import type { PageProps } from './$types';

const SITE_ORIGIN = 'https://flaxia.app';
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og-default-v2.png`;

let { data }: PageProps = $props();

const ssrPosts = $derived(data.root ? [data.root, ...data.replies] : []);
const description = $derived(
  (data.root ? stripPostColors(data.root.text) : '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'A post on Flaxia',
);
const metaTitle = $derived(`Flaxia - ${description}`);
const canonicalUrl = $derived(
  page.params.id ? `${SITE_ORIGIN}/thread/${encodeURIComponent(page.params.id)}` : page.url.href,
);
const ogImage = $derived.by(() => {
  const post = data.root;
  if (!post) return DEFAULT_OG_IMAGE;
  if (post.thumbnail_key) return `${SITE_ORIGIN}/api/thumbnail/${encodeURIComponent(post.id)}`;
  const imageKey = post.gif_key && !/^(audio|video)\//.test(post.gif_key) ? post.gif_key : post.avatar_key;
  return imageKey ? `${SITE_ORIGIN}/api/images/${encodeURIComponent(imageKey)}` : DEFAULT_OG_IMAGE;
});
const jsonLd = $derived.by(() => {
  const root = data.root;
  if (!root) return '';
  const postUrl = `${page.url.origin}${page.url.pathname}`;
  return [
    renderBlogPostingJsonLd(
      asSeoPostRow(root),
      root.display_name || root.username,
      `${page.url.origin}/users/${encodeURIComponent(root.username)}`,
      postUrl,
      description,
      root.thumbnail_key ? ogImage : undefined,
    ),
    renderBreadcrumbJsonLd(
      [
        { label: 'Home', url: `${page.url.origin}/home` },
        { label: 'Thread', url: postUrl },
      ],
      page.url.origin,
    ),
  ].join('\n');
});
let currentUser = $state<unknown>(null);
onMount(() => {
  currentUser = getSessionUser() ?? null;
});
</script>

<svelte:head>
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
  <ThreadPage
    postId={page.params.id ?? ''}
    sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
    currentUser={currentUser as never}
    onBack={() => void navigate('/home')}
  />
  <SsrPostList posts={ssrPosts} label="Thread" />
{/key}
