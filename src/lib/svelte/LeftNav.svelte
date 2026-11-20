<script lang="ts">
import { createLeftNav } from '../../components/LeftNav.ts';
import { setupMobileLeftNav } from '../../lib/left-nav-drawer.ts';

// Svelte-owned shell slot. F6-F8 pages can drop this in instead of letting
// the legacy main.ts create the nav; the DOM/behavior stays identical.
let { props = {} }: { props?: Parameters<typeof createLeftNav>[0] } = $props();
let host: HTMLDivElement;
let nav: ReturnType<typeof createLeftNav> | null = null;

// Props arrive after getMe() resolves. Rebuild the nav when they change so a
// signed-in user sees their own state and working navigation handlers.
$effect(() => {
  const next = props;
  if (!host) return;
  nav?.destroy();
  nav = createLeftNav(next);
  host.replaceChildren(nav.getElement());
  setupMobileLeftNav(nav.getElement());
  return () => nav?.destroy();
});
</script>

<div bind:this={host} style="display: contents"></div>
