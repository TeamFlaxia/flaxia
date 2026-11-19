<script lang="ts">
import { onMount } from 'svelte';
import { getBottomNav } from '../../lib/bottom-nav-setup.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from './ShellLayout.svelte';

let { gameId = '' }: { gameId?: string } = $props();
let host: HTMLDivElement;
// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
let navProps: Record<string, unknown> = {};

const pathFor = (view: string, postId?: string, username?: string): string => {
  if (view === 'timeline') return '/home';
  if (view === 'profile') return `/profile/${username ?? ''}`;
  return `/${view}`;
};

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    const { getMe } = await import('../../lib/auth-cache.ts');
    const { createLeftNavHandlers } = await import('../../lib/left-nav-handlers.ts');
    await initI18n();
    const me = await getMe();
    const user = me?.user as { id: string; username: string; display_name?: string; avatar_key?: string } | undefined;
    const { createArcadePage } = await import('../../components/ArcadePage.ts');
    const page = createArcadePage({
      sandboxOrigin: import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app',
      currentUser: user ?? null,
      initialGameId: gameId || undefined,
      onBack: () => window.location.assign('/home'),
    });
    host.appendChild(page.getElement());
    dispose = page.destroy;
    getBottomNav()?.setActiveItem('arcade');
    navProps = {
      activeItem: 'arcade',
      currentUser: user,
      ...createLeftNavHandlers({
        navigate: (view, postId, username) => window.location.assign(pathFor(view, postId, username)),
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

<style>
  :global(#app) {
    display: none;
  }
</style>
