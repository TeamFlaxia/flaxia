<script lang="ts">
import { onMount } from 'svelte';

let host: HTMLDivElement;

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    await initI18n();
    const { createRightPanel } = await import('../../components/RightPanel.ts');
    const panel = createRightPanel();
    host.appendChild(panel.getElement());
    dispose = panel.destroy;
  })();
  return () => dispose();
});
</script>

<div bind:this={host}></div>
