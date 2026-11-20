<script lang="ts">
import { onMount } from 'svelte';
import { ensureBottomNav, getBottomNav } from '../../lib/bottom-nav-setup.ts';
import { leftNavCallbacks } from '../../lib/left-nav-handlers.ts';
import { parseCurrentRoute } from '../../lib/router.ts';
import { viewToBottomNavId } from '../../lib/view-nav.ts';
import LeftNav from './LeftNav.svelte';
import RightPanel from './RightPanel.svelte';
import { getSessionUser } from './session.ts';

void LeftNav;
void RightPanel;
// Standalone shell slot for F6-F8 pages. The legacy three-column classes and
// role="main" landmark are kept so CSS and accessibility behave identically.
let {
  // biome-ignore lint/correctness/noUnusedVariables: Svelte snippet used in markup
  children,
  navProps = {},
  // biome-ignore lint/correctness/noUnusedVariables: Svelte prop used in markup
  showRightPanel = true,
}: {
  children: import('svelte').Snippet;
  navProps?: Record<string, unknown>;
  showRightPanel?: boolean;
} = $props();

// Routes set navProps after their async setup. Merge a synchronous fallback so
// the first render already has the signed-in user and working nav handlers —
// otherwise the nav flashes the guest state on every navigation.
const fallbackNavProps = () => ({
  activeItem: parseCurrentRoute()?.view ?? 'home',
  currentUser: getSessionUser() ?? undefined,
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
    getCurrentUsername: () => getSessionUser()?.username ?? null,
  }),
});

void fallbackNavProps;

$effect(() => {
  getBottomNav()?.setActiveItem(String(navProps.activeItem ?? 'home'));
});

$effect(() => {
  const user = navProps.currentUser;
  getBottomNav()?.updateUser(user as never);
});

onMount(() => {
  void ensureBottomNav({
    navigate: (view, postId, username) => {
      const path =
        view === 'timeline'
          ? '/home'
          : view === 'profile'
            ? `/profile/${username ?? ''}`
            : `/${view}${postId ? `/${postId}` : ''}`;
      window.location.assign(path);
    },
    getCurrentUser: () => navProps.currentUser as never,
    getActiveItem: () => viewToBottomNavId(parseCurrentRoute()?.view ?? ''),
  });
});
</script>

<div class="main-container">
  <LeftNav props={{ ...fallbackNavProps(), ...navProps }} />
  <div class="main-content" role="main">{@render children()}</div>
  {#if showRightPanel}
    <RightPanel />
  {/if}
</div>
