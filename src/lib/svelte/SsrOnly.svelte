<script lang="ts">
import { onMount } from 'svelte';

// Renders server-side only: `hydrated` is false during SSR and the first
// client render, then flips in onMount so hydration never mismatches.
let { children }: { children: import('svelte').Snippet } = $props();

let hydrated = $state(false);
onMount(() => {
  hydrated = true;
});
</script>

{#if !hydrated}
  {@render children()}
{/if}
