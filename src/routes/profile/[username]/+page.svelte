<script lang="ts">
import { page } from '$app/state';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import LegacyShellPage from '../../../lib/svelte/LegacyShellPage.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
const load = async () => {
  const { createProfilePage } = await import('../../../components/ProfilePage.ts');
  return createProfilePage({
    username: page.params.username,
    currentUser: getSessionUser() ?? undefined,
    sandboxOrigin: import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app',
    onOpenSettings: () => window.location.assign('/settings'),
  });
};
</script>

<LegacyShellPage {load} activeItem="profile" />
