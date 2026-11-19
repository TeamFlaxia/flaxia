<script lang="ts">
import { page } from '$app/state';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import LegacyShellPage from '../../lib/svelte/LegacyShellPage.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
const load = async () => {
  const { createSearchPage } = await import('../../components/SearchPage.ts');
  return createSearchPage({
    query: page.url.searchParams.get('q') || '',
    type: (page.url.searchParams.get('type') as 'posts' | 'users' | 'arcade' | 'web') || 'posts',
    currentUser: getSessionUser() ?? undefined,
    sandboxOrigin: import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app',
  });
};
</script>

<LegacyShellPage {load} activeItem="search" />
