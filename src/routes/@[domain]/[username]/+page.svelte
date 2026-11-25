<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import RemoteProfilePage from '../../../lib/svelte/RemoteProfilePage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';

// The session is client-only; start null so SSR and the first client render agree.
let currentUser = $state<unknown>(null);
onMount(() => {
  currentUser = getSessionUser() ?? null;
});
</script>

<ShellLayout navProps={{ activeItem: 'profile', currentUser }}>
{#key `${page.params.domain}/${page.params.username}`}
    <RemoteProfilePage
      domain={page.params.domain}
      username={page.params.username}
      currentUser={currentUser as never}
    />
{/key}
</ShellLayout>
