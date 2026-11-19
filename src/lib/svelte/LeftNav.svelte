<script lang="ts">
import { onMount } from 'svelte';
import { createLeftNav } from '../../components/LeftNav.ts';
import { initI18n } from '../../lib/i18n.ts';

// Svelte-owned shell slot. F6-F8 pages can drop this in instead of letting
// the legacy main.ts create the nav; the DOM/behavior stays identical.
let { props = {} }: { props?: Parameters<typeof createLeftNav>[0] } = $props();
let host: HTMLDivElement;

onMount(() => {
  // Fire-and-forget like the legacy bootstrap: waiting for locale JSON here
  // would shift the shell after first paint and regress CLS.
  void initI18n();
  const nav = createLeftNav(props);
  host.appendChild(nav.getElement());
  return () => nav.destroy();
});
</script>

<div bind:this={host}></div>
