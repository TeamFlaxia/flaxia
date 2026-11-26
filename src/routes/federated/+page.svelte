<script lang="ts">
import { onMount } from 'svelte';
// biome-ignore lint/correctness/noUnusedImports: used in <svelte:head>
import { pageDescription } from '../../lib/page-title.ts';
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

<svelte:head>
  <meta name="description" content={pageDescription('/federated')} />
  <meta property="og:description" content={pageDescription('/federated')} />
  <meta name="twitter:description" content={pageDescription('/federated')} />
</svelte:head>

<ShellLayout navProps={{ activeItem: 'federated', currentUser }}>
  <FederatedPage
    sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
    {currentUser}
  />
</ShellLayout>
