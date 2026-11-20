<script lang="ts">
import { createLeftNav } from '../../components/LeftNav.ts';
import { openLeftNav, setupMobileLeftNav } from '../../lib/left-nav-drawer.ts';

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
  // navProps arrives asynchronously, so this effect can re-run while the
  // mobile drawer is open. Rebuild the DOM but carry the open state over —
  // otherwise the freshly created nav silently loses `left-nav--open`.
  const wasOpen = nav?.getElement().classList.contains('left-nav--open') ?? false;
  nav?.destroy();
  nav = createLeftNav(next);
  host.replaceChildren(nav.getElement());
  setupMobileLeftNav(nav.getElement());
  if (wasOpen) openLeftNav(nav.getElement());
  return () => nav?.destroy();
});
</script>

<div bind:this={host} style="display: contents"></div>
