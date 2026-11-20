<script lang="ts">
import { onMount } from 'svelte';
import { startAuthRedirect } from '../../lib/svelte/auth-start.ts';

// The sign-up UI lives on auth.flaxia.app. This route only starts the redirect.
onMount(() => {
  void startAuthRedirect('register');
});
</script>
