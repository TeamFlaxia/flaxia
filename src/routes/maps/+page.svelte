<script lang="ts">
import { onMount } from 'svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';
import { getBottomNav } from '../../lib/bottom-nav-setup.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';

let host: HTMLDivElement;
// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
let navProps: Record<string, unknown> = {};

onMount(() => {
  // Maps has no bottom-nav tab; clear it before any awaits.
  getBottomNav()?.setActiveItem('');
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    const { createLeftNavHandlers } = await import('../../lib/left-nav-handlers.ts');
    await initI18n();
    const user = getSessionUser() as { id: string; username: string } | undefined;
    const { createMapsPage } = await import('../../components/MapsPage.ts');
    const map = createMapsPage();
    host.appendChild(map.getElement());
    dispose = map.destroy;
    navProps = {
      activeItem: 'maps',
      currentUser: user,
      ...createLeftNavHandlers({
        navigate: (view, postId, username) => window.location.assign(view === 'timeline' ? '/home' : `/${view}`),
        getCurrentUsername: () => user?.username ?? null,
      }),
    };
  })();
  return () => dispose();
});
</script>

<ShellLayout {navProps} showRightPanel={false}>
  <div bind:this={host}></div>
</ShellLayout>
