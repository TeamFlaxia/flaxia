<script lang="ts">
import { onMount } from 'svelte';
import { page } from '$app/state';
import SearchPage from '../../lib/svelte/SearchPage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';

// The session is client-only; start null so SSR and the first client render agree.
let currentUser = $state<unknown>(null);
onMount(() => {
  currentUser = getSessionUser() ?? null;
});
</script>

<ShellLayout navProps={{ activeItem: 'search', currentUser }}>
{#key page.url.search}
    <SearchPage
      query={page.url.searchParams.get('q') || ''}
      type={(page.url.searchParams.get('type') as 'posts' | 'users' | 'arcade' | 'web') || 'posts'}
      currentUser={currentUser as Record<string, unknown> | null}
      sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
    />
{/key}
</ShellLayout>
