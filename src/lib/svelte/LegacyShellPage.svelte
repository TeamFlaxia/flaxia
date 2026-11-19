<script lang="ts">
import { onMount } from 'svelte';
import { createLeftNavHandlers } from '../../lib/left-nav-handlers.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from './ShellLayout.svelte';
import { getSessionUser } from './session.ts';

type LegacyHandle = { getElement: () => HTMLElement; destroy: () => void };
let { load, activeItem }: { load: () => Promise<LegacyHandle>; activeItem: string } = $props();
let host: HTMLDivElement;

const user = getSessionUser();
// biome-ignore lint/correctness/noUnusedVariables: Svelte prop used in markup
const navProps = {
  activeItem,
  currentUser: user ?? undefined,
  ...createLeftNavHandlers({
    navigate: (view: string, postId?: string, username?: string) => {
      const path =
        view === 'timeline'
          ? '/home'
          : view === 'profile'
            ? `/profile/${username ?? ''}`
            : `/${view}${postId ? `/${postId}` : ''}`;
      window.location.assign(path);
    },
    getCurrentUsername: () => user?.username ?? null,
  }),
};

onMount(() => {
  let dispose = () => {};
  void load().then((page) => {
    host.appendChild(page.getElement());
    dispose = page.destroy;
  });
  return () => dispose();
});
</script>

<ShellLayout {navProps}>
  <div bind:this={host}></div>
</ShellLayout>
