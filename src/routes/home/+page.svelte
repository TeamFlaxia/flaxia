<script lang="ts">
import { onMount } from 'svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';

let host: HTMLDivElement;
let composerHost: HTMLDivElement;
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
    const { leftNavCallbacks } = await import('../../lib/left-nav-handlers.ts');
    const { openLeftNav } = await import('../../lib/left-nav-drawer.ts');
    await initI18n();
    const user = getSessionUser() as
      | {
          id: string;
          username: string;
          display_name?: string;
          avatar_key?: string;
          badge_type?: string | null;
        }
      | undefined;
    const { mount, unmount } = await import('svelte');
    const { default: Composer } = await import('../../lib/svelte/Composer.svelte');
    const composerInstance = user && composerHost ? mount(Composer, { target: composerHost }) : null;
    const { createTimeline } = await import('../../components/Timeline.ts');
    const timeline = createTimeline({
      sandboxOrigin: import.meta.env.VITE_SANDBOX_ORIGIN || 'https://sandbox.flaxia.app',
      currentUser: user ?? null,
      composerHost: composerInstance ? composerHost : undefined,
    });
    const element = timeline.getElement();
    element.addEventListener('openLeftNav', () => {
      const nav = document.querySelector<HTMLElement>('.left-nav');
      if (nav) openLeftNav(nav);
    });
    host.appendChild(element);
    dispose = () => {
      if (composerInstance) unmount(composerInstance);
      timeline.destroy();
    };
    navProps = {
      activeItem: 'home',
      currentUser: user,
      ...leftNavCallbacks({
        navigate: (view, postId, username) => window.location.assign(pathFor(view, postId, username)),
        getCurrentUsername: () => user?.username ?? null,
      }),
    };
  })();
  return () => dispose();
});
</script>

<ShellLayout {navProps}>
  <div bind:this={composerHost}></div>
  <div bind:this={host}></div>
</ShellLayout>
