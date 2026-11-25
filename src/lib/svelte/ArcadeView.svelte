<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onMount } from 'svelte';
import { getBottomNav } from '../../lib/bottom-nav-setup.ts';
import { navigate } from '../../lib/navigation.ts';
import { viewToPath } from '../../lib/view-nav.ts';
import ArcadePage from './arcade/ArcadePage.svelte';
import ShellLayout from './ShellLayout.svelte';
import { getSessionUser } from './session.ts';

let { gameId = '' }: { gameId?: string } = $props();

type ArcadeUser = {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
};

// The root layout load resolves the session before the route mounts, so the
// first feed request already knows whether recommendations are available.
// Start undefined so SSR and the first client render match.
let currentUser = $state<ArcadeUser | undefined>(undefined);
let navProps: Record<string, unknown> = $state({});

onMount(() => {
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    const { leftNavCallbacks } = await import('../../lib/left-nav-handlers.ts');
    await initI18n();
    const user = getSessionUser() ?? undefined;
    currentUser = user;
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
});
</script>

<ShellLayout {navProps} showRightPanel={false}>
  {#key currentUser?.id ?? 'guest'}
    <ArcadePage
      sandboxOrigin={import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app'}
      currentUser={currentUser ?? null}
      initialGameId={gameId || undefined}
      onBack={() => void navigate('/home')}
    />
  {/key}
</ShellLayout>
