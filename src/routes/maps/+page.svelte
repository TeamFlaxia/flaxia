<script lang="ts">
import { onMount } from 'svelte';
import { getBottomNav } from '../../lib/bottom-nav-setup.ts';
import { navigate } from '../../lib/navigation.ts';
import MapsPage from '../../lib/svelte/MapsPage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';
import { viewToPath } from '../../lib/view-nav.ts';

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
let navProps: Record<string, unknown> = {};

onMount(() => {
  // Maps has no bottom-nav tab; clear it before any awaits.
  getBottomNav()?.setActiveItem('');
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    const { leftNavCallbacks } = await import('../../lib/left-nav-handlers.ts');
    await initI18n();
    const user = getSessionUser() as { id: string; username: string } | undefined;
    navProps = {
      activeItem: 'maps',
      currentUser: user,
      ...leftNavCallbacks({
        navigate: (view, postId, username) => void navigate(viewToPath(view, postId, username)),
        getCurrentUsername: () => user?.username ?? null,
      }),
    };
  })();
});
</script>

<ShellLayout {navProps} showRightPanel={false}>
  <MapsPage />
</ShellLayout>
