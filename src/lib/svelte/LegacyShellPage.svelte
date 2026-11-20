<script lang="ts">
import { untrack } from 'svelte';
import { page } from '$app/state';
import { leftNavCallbacks } from '../../lib/left-nav-handlers.ts';
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
  ...leftNavCallbacks({
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

let dispose = () => {};
let mountedUrl: string | null = null;

// Legacy DOM callers navigate by pushState + spaNavigate, which SvelteKit sees
// as a URL change on the *same* route. Re-run the legacy page factory so search
// queries, explore tags and other URL-encoded state actually take effect.
$effect(() => {
  const url = page.url.href;
  if (!host || url === mountedUrl) return;
  mountedUrl = url;
  const pending = untrack(() => load());
  let cancelled = false;
  void pending.then((handle) => {
    if (cancelled) {
      handle.destroy();
      return;
    }
    host.replaceChildren(handle.getElement());
    dispose = handle.destroy;
  });
  return () => {
    cancelled = true;
    dispose();
    dispose = () => {};
  };
});
</script>

<ShellLayout {navProps}>
  <div bind:this={host}></div>
</ShellLayout>
