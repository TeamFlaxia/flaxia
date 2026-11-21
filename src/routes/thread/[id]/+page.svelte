<script lang="ts">
import { page } from '$app/state';
import { navigate } from '../../../lib/navigation.ts';
import { getSessionUser } from '../../../lib/svelte/session.ts';
import ThreadPage from '../../../lib/svelte/ThreadPage.svelte';
</script>

{#key page.params.id}
  <ThreadPage
    postId={page.params.id ?? ''}
    sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
    currentUser={(getSessionUser() ?? null) as never}
    onBack={() => void navigate('/home')}
  />
{/key}
