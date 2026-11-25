<script lang="ts">
import '../styles/index.css';
import '../styles/ssr.css';
import { onMount } from 'svelte';
import { beforeNavigate } from '$app/navigation';
import { page } from '$app/state';
import { getBottomNav } from '../lib/bottom-nav-setup.ts';
import { closeLeftNav } from '../lib/left-nav-drawer.ts';
import { pageTitle } from '../lib/page-title.ts';
import { parseCurrentRoute } from '../lib/router.ts';
import { renderWebSiteJsonLd } from '../lib/seo-jsonld.ts';
import { viewToBottomNavId } from '../lib/view-nav.ts';

// biome-ignore lint/correctness/noUnusedVariables: Svelte snippet used in markup
let { children } = $props();

// These routes describe their own content in <svelte:head>; the generic tags
// below must not shadow their per-post/per-user metadata.
const OWN_META_ROUTES: ReadonlySet<string> = new Set(['/thread/[id]', '/users/[username]', '/arcade', '/arcade/[id]']);
const SITE_DESCRIPTION = 'The SNS where your posts are playable.';
const DEFAULT_OG_IMAGE = 'https://flaxia.app/og-default-v2.png';

let localeVersion = $state(0);
const documentTitle = $derived.by(() => {
  localeVersion;
  return pageTitle(page.url.pathname);
});
const hasRouteMeta = $derived(OWN_META_ROUTES.has(page.route?.id ?? ''));
// +error.svelte owns the head on error responses (title, description,
// canonical, noindex). The generic tags and the indexable WebSite block must
// not shadow it or make an error page look crawlable.
const isError = $derived(page.status >= 400);
// Routes in OWN_META_ROUTES describe themselves; emitting the generic WebSite
// block there would duplicate/conflict with their per-post, per-user or
// arcade metadata.
const jsonLd = $derived(isError || hasRouteMeta ? '' : renderWebSiteJsonLd('Flaxia', page.url.origin));

// The drawer is an overlay on <body>; a client-side route change replaces the
// nav element but leaves the overlay and body scroll lock behind.
beforeNavigate(() => closeLeftNav());

// The legacy app used to sync the bottom bar on popstate. Keep this at the
// root so it survives every Svelte route transition.
onMount(() => {
  const sync = () => getBottomNav()?.setActiveItem(viewToBottomNavId(parseCurrentRoute()?.view ?? ''));
  window.addEventListener('popstate', sync);
  const onLocale = () => (localeVersion += 1);
  window.addEventListener('localechange', onLocale);
  sync();
  return () => {
    window.removeEventListener('popstate', sync);
    window.removeEventListener('localechange', onLocale);
  };
});
</script>

<svelte:head>
  {#if !isError}
    <title>{documentTitle}</title>
    {#if jsonLd}{@html jsonLd}{/if}
    {#if !hasRouteMeta}
      <meta name="description" content={SITE_DESCRIPTION} />
      <meta property="og:title" content={documentTitle} />
      <meta property="og:description" content={SITE_DESCRIPTION} />
      <meta property="og:url" content={page.url.href} />
      <meta property="og:image" content={DEFAULT_OG_IMAGE} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={documentTitle} />
      <meta name="twitter:description" content={SITE_DESCRIPTION} />
      <meta name="twitter:image" content={DEFAULT_OG_IMAGE} />
    {/if}
  {/if}
</svelte:head>

{@render children()}
