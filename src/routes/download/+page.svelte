<script lang="ts">
import { onMount } from 'svelte';

let host: HTMLDivElement;

onMount(() => {
  let dispose = () => {};
  void (async () => {
    // The legacy shell normally starts i18n; this route owns the page now.
    const { initI18n } = await import('../../lib/i18n.ts');
    await initI18n();
    const { createDownloadPage } = await import('../../components/DownloadPage.ts');
    const page = createDownloadPage();
    host.appendChild(page.getElement());
    dispose = page.destroy;
  })();
  return () => dispose();
});
</script>

<div bind:this={host}></div>
