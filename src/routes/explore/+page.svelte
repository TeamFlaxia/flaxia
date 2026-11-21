<script lang="ts">
import { page } from '$app/state';
import ExplorePage from '../../lib/svelte/ExplorePage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';
</script>

<ShellLayout navProps={{ activeItem: 'explore', currentUser: getSessionUser() ?? null }}>
{#key page.url.searchParams.get('tag') ?? ''}
    <ExplorePage
      tag={page.url.searchParams.get('tag') || undefined}
      sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
      currentUser={getSessionUser() ?? null}
    />
{/key}
</ShellLayout>
