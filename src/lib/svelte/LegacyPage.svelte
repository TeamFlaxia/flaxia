<script lang="ts">
import { onMount } from 'svelte';

type LegacyPageHandle = { getElement: () => HTMLElement; destroy: () => void };

let { load }: { load: () => Promise<LegacyPageHandle> } = $props();
let host: HTMLDivElement;

onMount(() => {
  let dispose = () => {};
  void (async () => {
    // The legacy shell normally starts i18n; Svelte-owned pages must do it.
    const { initI18n } = await import('../i18n.ts');
    await initI18n();
    const page = await load();
    host.appendChild(page.getElement());
    dispose = page.destroy;
  })();
  return () => dispose();
});
</script>

<div bind:this={host}></div>
