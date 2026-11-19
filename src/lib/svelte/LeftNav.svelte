<script lang="ts">
import { onMount } from 'svelte';

// Svelte-owned shell slot. F6-F8 pages can drop this in instead of letting
// the legacy main.ts create the nav; the DOM/behavior stays identical.
let { props = {} }: { props?: Parameters<typeof import('../../components/LeftNav.ts')['createLeftNav']>[0] } = $props();
let host: HTMLDivElement;

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    await initI18n();
    const { createLeftNav } = await import('../../components/LeftNav.ts');
    const nav = createLeftNav(props);
    host.appendChild(nav.getElement());
    dispose = nav.destroy;
  })();
  return () => dispose();
});
</script>

<div bind:this={host}></div>
