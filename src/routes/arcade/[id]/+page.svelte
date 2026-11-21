<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: Svelte prop used in markup
import { page } from '$app/state';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ArcadeView from '../../../lib/svelte/ArcadeView.svelte';
</script>

{#key page.params.id}
  <ArcadeView gameId={page.params.id} />
{/key}
