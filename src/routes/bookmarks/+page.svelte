<script lang="ts">
import { onMount } from 'svelte';
import { navigate } from '../../lib/navigation.ts';
import BookmarksPage from '../../lib/svelte/BookmarksPage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';

let user = $state<Record<string, unknown> | null>(null);

onMount(() => {
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    await initI18n();
    const session = getSessionUser();
    if (!session) {
      await navigate('/explore', { replaceState: true });
      return;
    }
    user = session as unknown as Record<string, unknown>;
  })();
});
</script>

<ShellLayout navProps={{ activeItem: 'bookmarks', currentUser: user }}>
  {#if user}
    <BookmarksPage
      sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
      currentUser={user as { username: string; id: string }}
    />
  {/if}
</ShellLayout>
