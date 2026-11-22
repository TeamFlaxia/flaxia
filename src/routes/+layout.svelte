<script lang="ts">
import '../styles/index.css';
import '../app.css';
import { onMount } from 'svelte';
import { beforeNavigate } from '$app/navigation';
import { page } from '$app/state';
import { getBottomNav } from '../lib/bottom-nav-setup.ts';
import { closeLeftNav } from '../lib/left-nav-drawer.ts';
import { pageTitle } from '../lib/page-title.ts';
import { parseCurrentRoute } from '../lib/router.ts';
import { viewToBottomNavId } from '../lib/view-nav.ts';

// biome-ignore lint/correctness/noUnusedVariables: Svelte snippet used in markup
let { children } = $props();

let localeVersion = $state(0);
const documentTitle = $derived.by(() => {
  localeVersion;
  return pageTitle(page.url.pathname);
});

// The drawer is an overlay on <body>; a client-side route change replaces the
// nav element but leaves the overlay and body scroll lock behind.
beforeNavigate(() => closeLeftNav());

// The legacy app used to sync the bottom bar on popstate. Keep this at the
// root so it survives every Svelte route transition.
onMount(() => {
  // The static first-fold placeholder is replaced by the mounted app in the
  // same frame, so slow clients do not produce a layout shift.
  queueMicrotask(() => {
    document.getElementById('initial-feed-skeleton')?.remove();
    window.dispatchEvent(new Event('flaxia:app-ready'));
  });
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
  <title>{documentTitle}</title>
</svelte:head>

{@render children()}
