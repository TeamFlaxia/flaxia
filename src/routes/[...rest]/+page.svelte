<script lang="ts">
import { onMount } from 'svelte';

onMount(() => {
  // Mount the existing app verbatim. It owns #app, routing, styles and every
  // component until the F5-F8 migration moves them into Svelte routes.
  void import('../../main.ts').then(({ mountLegacyApp }) => mountLegacyApp());
});
</script>
