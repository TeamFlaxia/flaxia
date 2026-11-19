<script lang="ts">
import { page } from '$app/state';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import LegacyShellPage from '../../lib/svelte/LegacyShellPage.svelte';

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
const load = async () => {
  const { createExplorePage } = await import('../../components/ExplorePage.ts');
  return createExplorePage({
    tag: page.url.searchParams.get('tag') || undefined,
    sandboxOrigin: import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app',
    currentUser: (await import('../../lib/svelte/session.ts')).getSessionUser() ?? undefined,
  });
};
</script>

<LegacyShellPage {load} activeItem="explore" />
