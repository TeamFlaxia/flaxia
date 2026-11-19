<script lang="ts">
import { onMount } from 'svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';

let host: HTMLDivElement;

const pathFor = (view: string, postId?: string, username?: string): string => {
  if (view === 'timeline') return '/home';
  if (view === 'profile') return `/profile/${username ?? ''}`;
  return `/${view}`;
};

onMount(() => {
  let dispose = () => {};
  void (async () => {
    const { initI18n } = await import('../../lib/i18n.ts');
    const { createLeftNavHandlers } = await import('../../lib/left-nav-handlers.ts');
    await initI18n();
    const user = getSessionUser();
    if (!user) {
      window.location.replace('/explore');
      return;
    }
    const currentUser = user as Parameters<
      typeof import('../../components/BookmarksPage.ts')['createBookmarksPage']
    >[0]['currentUser'];
    const { createBookmarksPage } = await import('../../components/BookmarksPage.ts');
    const page = createBookmarksPage({
      sandboxOrigin: import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app',
      currentUser,
    });
    host.appendChild(page.getElement());
    dispose = page.destroy;
    // Shell nav props are applied by ShellLayout's LeftNav through this route.
    navProps = {
      activeItem: 'bookmarks',
      currentUser,
      ...createLeftNavHandlers({
        navigate: (view, postId, username) => window.location.assign(pathFor(view, postId, username)),
        getCurrentUsername: () => (currentUser?.username as string | undefined) ?? null,
      }),
    };
  })();
  return () => dispose();
});

// biome-ignore lint/correctness/noUnusedVariables: Svelte shorthand prop in markup
let navProps: Record<string, unknown> = {};
</script>

<ShellLayout {navProps}>
  <div bind:this={host}></div>
</ShellLayout>
