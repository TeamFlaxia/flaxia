<script lang="ts">
import '../styles/index.css';
import '../styles/ssr.css';
import { onMount } from 'svelte';
import { beforeNavigate } from '$app/navigation';
import { page } from '$app/state';
import { getBottomNav } from '../lib/bottom-nav-setup.ts';
import { t } from '../lib/i18n.ts';
import { closeLeftNav } from '../lib/left-nav-drawer.ts';
import { pageTitle } from '../lib/page-title.ts';
import { parseCurrentRoute } from '../lib/router.ts';
import { renderWebSiteJsonLd, SEO_ORIGIN } from '../lib/seo-jsonld.ts';
import { viewToBottomNavId } from '../lib/view-nav.ts';

// biome-ignore lint/correctness/noUnusedVariables: Svelte snippet used in markup
let { children } = $props();

// These routes own their description/canonical in a route head; the generic
// tags below must not shadow their per-article/per-post metadata. `/download`
// is included because its component owns its description and og:url.
const OWN_META_ROUTES: ReadonlySet<string> = new Set([
  '/thread/[id]',
  '/users/[username]',
  '/arcade',
  '/arcade/[id]',
  '/download',
  '/docs',
  '/docs/[slug]',
  '/about',
  '/terms',
  '/privacy',
  '/child-safety',
]);
// Routes whose title/canonical come from their own data: the docs and legal
// loads return `title`, and the thread/user/arcade pages render a title tag.
const OWN_TITLE_ROUTES: ReadonlySet<string> = new Set([
  '/thread/[id]',
  '/users/[username]',
  '/arcade',
  '/arcade/[id]',
  '/docs',
  '/docs/[slug]',
  '/about',
  '/terms',
  '/privacy',
  '/child-safety',
]);
// Only these actually render a document title themselves. For docs/legal the
// layout renders the single title using page.data.title from the load.
const SELF_TITLE_TAG_ROUTES: ReadonlySet<string> = new Set([
  '/thread/[id]',
  '/users/[username]',
  '/arcade',
  '/arcade/[id]',
]);
// Authenticated-only views must never be indexed, but they still share the
// generic title/canonical tags.
const PRIVATE_ROUTE_IDS: ReadonlySet<string> = new Set([
  '/settings',
  '/mail',
  '/mail/compose',
  '/mail/settings',
  '/notifications',
  '/bookmarks',
  '/admin',
  '/admin/[tab]',
]);
const SITE_DESCRIPTION = 'The SNS where your posts are playable.';
const DEFAULT_OG_IMAGE = `${SEO_ORIGIN}/og-default-v2.png`;

let localeVersion = $state(0);

// Called from the template (the render path) so it may read reactive page
// state; a module-level evaluation would trip Svelte's state_read_outside_render.
function routeTitle(): string {
  localeVersion;
  const loadedTitle = page.data?.title;
  return typeof loadedTitle === 'string' && loadedTitle ? loadedTitle : pageTitle(page.url.pathname);
}

function siteDescription(): string {
  localeVersion;
  const localized = t('site.description');
  return localized === 'site.description' ? SITE_DESCRIPTION : localized;
}

// Path-only canonical URL on the production origin: query strings and the
// local/dev origin must never leak into canonical or og:url.
const canonicalUrl = $derived(`${SEO_ORIGIN}${page.url.pathname}`);
const routeId = $derived(page.route?.id ?? '');
const hasRouteTitle = $derived(OWN_TITLE_ROUTES.has(routeId));
const hasOwnMeta = $derived(OWN_META_ROUTES.has(routeId));
const hasSelfTitle = $derived(SELF_TITLE_TAG_ROUTES.has(routeId));
const isPrivateRoute = $derived(PRIVATE_ROUTE_IDS.has(routeId));
// Generic WebSite metadata must not shadow a route that describes itself.
const jsonLd = $derived(hasOwnMeta ? '' : renderWebSiteJsonLd('Flaxia', SEO_ORIGIN));

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
  {#if page.status < 400}
    {#if !hasSelfTitle}
      <title>{routeTitle()}</title>
    {/if}
    {#if !hasRouteTitle}
      <link rel="canonical" href={canonicalUrl} />
    {/if}
    {#if isPrivateRoute}
      <meta name="robots" content="noindex, nofollow" />
    {/if}
    {#if jsonLd}{@html jsonLd}{/if}
    {#if !hasOwnMeta}
      <meta name="description" content={siteDescription()} />
      <meta property="og:title" content={routeTitle()} />
      <meta property="og:description" content={siteDescription()} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:image" content={DEFAULT_OG_IMAGE} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={routeTitle()} />
      <meta name="twitter:description" content={siteDescription()} />
      <meta name="twitter:image" content={DEFAULT_OG_IMAGE} />
    {/if}
  {/if}
</svelte:head>

{@render children()}
