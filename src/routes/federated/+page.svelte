<script lang="ts">
import { onMount } from 'svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import FederatedPage from '../../lib/svelte/FederatedPage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';

// The session is client-only; start null so SSR and the first client render
// agree. Guests use the same public API as signed-in users.
let currentUser = $state<{
  username: string;
  id: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
} | null>(null);

onMount(() => {
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    await initI18n();
    currentUser = (getSessionUser() as typeof currentUser) ?? null;
  })();
});
</script>

<!-- This route has no per-article title/canonical: the root layout owns its
     description, OG, Twitter and JSON-LD tags, so no duplicate head tags here. -->
<ShellLayout navProps={{ activeItem: 'federated', currentUser }}>
  <FederatedPage
    sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
    {currentUser}
  />
</ShellLayout>
