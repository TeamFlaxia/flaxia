<script lang="ts">
import { onMount } from 'svelte';

// Every known view has its own Svelte route; unknown paths go home.
onMount(() => {
  window.location.replace('/home');
});
</script>
