<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import ExplorePage from '../../lib/svelte/ExplorePage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';

// The session is client-only; start null so SSR and the first client render agree.
let currentUser = $state<unknown>(null);
onMount(() => {
  currentUser = getSessionUser() ?? null;
});
</script>

<ShellLayout navProps={{ activeItem: 'explore', currentUser }}>
{#key page.url.searchParams.get('tag') ?? ''}
    <ExplorePage
      tag={page.url.searchParams.get('tag') || undefined}
      sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
      currentUser={currentUser as never}
    />
{/key}
</ShellLayout>
