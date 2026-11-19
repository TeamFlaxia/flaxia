<script lang="ts">
import { page } from '$app/state';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import LegacyShellPage from '../../../lib/svelte/LegacyShellPage.svelte';
import { getSessionUser } from '../../../lib/svelte/session.ts';

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
const load = async () => {
  const { createRemoteProfilePage } = await import('../../../components/RemoteProfilePage.ts');
  return createRemoteProfilePage({
    domain: page.params.domain,
    username: page.params.username,
    currentUser: getSessionUser() ?? undefined,
  });
};
</script>

<LegacyShellPage {load} activeItem="profile" />
