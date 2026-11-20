<script lang="ts">
import { onMount } from 'svelte';
import { startAuthRedirect } from '../../lib/svelte/auth-start.ts';

// The login UI lives on auth.flaxia.app. This route only starts the redirect.
onMount(() => {
  void startAuthRedirect('login');
});
</script>
