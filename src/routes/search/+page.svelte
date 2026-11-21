<script lang="ts">
import { page } from '$app/state';
import SearchPage from '../../lib/svelte/SearchPage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';
</script>

<ShellLayout navProps={{ activeItem: 'search', currentUser: getSessionUser() ?? null }}>
{#key page.url.search}
    <SearchPage
      query={page.url.searchParams.get('q') || ''}
      type={(page.url.searchParams.get('type') as 'posts' | 'users' | 'arcade' | 'web') || 'posts'}
      currentUser={(getSessionUser() ?? null) as Record<string, unknown> | null}
      sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
    />
{/key}
</ShellLayout>
