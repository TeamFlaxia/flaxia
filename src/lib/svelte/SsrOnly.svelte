<script lang="ts">
import { onMount } from 'svelte';
import { hasSsrHandover, SSR_HANDOVER_EVENT } from '../ssr-handover.ts';

// Renders server-side only: `handover` is false during SSR and the first
// client render, then flips when the interactive view has taken over so
// hydration never mismatches and no-JS clients keep the markup.
let { children }: { children: import('svelte').Snippet } = $props();

let handover = $state(false);
onMount(() => {
  if (hasSsrHandover()) {
    handover = true;
    return;
  }
  const onHandover = () => {
    handover = true;
  };
  window.addEventListener(SSR_HANDOVER_EVENT, onHandover);
  return () => window.removeEventListener(SSR_HANDOVER_EVENT, onHandover);
});
</script>

{#if !handover}
  {@render children()}
{/if}
