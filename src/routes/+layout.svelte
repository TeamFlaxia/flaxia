<script lang="ts">
import '../styles/index.css';
import { onMount } from 'svelte';
import { getBottomNav } from '../lib/bottom-nav-setup.ts';
import { parseCurrentRoute } from '../lib/router.ts';
import { viewToBottomNavId } from '../lib/view-nav.ts';

// biome-ignore lint/correctness/noUnusedVariables: Svelte snippet used in markup
let { children } = $props();

// The legacy app used to sync the bottom bar on popstate. Keep this at the
// root so it survives every Svelte route transition.
onMount(() => {
  const sync = () => getBottomNav()?.setActiveItem(viewToBottomNavId(parseCurrentRoute()?.view ?? ''));
  window.addEventListener('popstate', sync);
  sync();
  return () => window.removeEventListener('popstate', sync);
});
</script>

{@render children()}
