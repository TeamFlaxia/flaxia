<script lang="ts">
import '../styles/index.css';

// biome-ignore lint/correctness/noUnusedVariables: Svelte snippet used in markup
let { children } = $props();
</script>

{@render children()}
