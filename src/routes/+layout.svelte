<script lang="ts">
// biome-ignore lint/correctness/noUnusedVariables: Svelte 5 snippet prop used by {@render children()}
let { children } = $props();
</script>

{@render children()}
