<script lang="ts">
import { onMount } from 'svelte';
import { createRightPanel } from '../../components/RightPanel.ts';

let host: HTMLDivElement;

onMount(() => {
  const panel = createRightPanel();
  host.appendChild(panel.getElement());
  return () => panel.destroy();
});
</script>

<div bind:this={host}></div>
