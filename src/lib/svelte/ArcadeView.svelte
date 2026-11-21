<script lang="ts">
import { onMount } from 'svelte';
import { mountArcadePage } from '../../lib/arcade/page.ts';
import { getBottomNav } from '../../lib/bottom-nav-setup.ts';
import { navigate } from '../../lib/navigation.ts';
import { viewToPath } from '../../lib/view-nav.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from './ShellLayout.svelte';
import { getSessionUser } from './session.ts';

let { gameId = '' }: { gameId?: string } = $props();
let host: HTMLDivElement;
// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
let navProps: Record<string, unknown> = {};

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    const { leftNavCallbacks } = await import('../../lib/left-nav-handlers.ts');
    await initI18n();
    const user = getSessionUser() as
      | { id: string; username: string; display_name?: string; avatar_key?: string }
      | undefined;
    const page = mountArcadePage(host, {
      sandboxOrigin: import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app',
      currentUser: user ?? null,
      initialGameId: gameId || undefined,
      onBack: () => void navigate('/home'),
    });
    dispose = () => page.destroy();
    getBottomNav()?.setActiveItem('arcade');
    navProps = {
      activeItem: 'arcade',
      currentUser: user,
      ...leftNavCallbacks({
        navigate: (view, postId, username) => void navigate(viewToPath(view, postId, username)),
        getCurrentUsername: () => user?.username ?? null,
      }),
    };
  })();
  return () => dispose();
});
</script>

<ShellLayout {navProps}>
  <div bind:this={host}></div>
</ShellLayout>
