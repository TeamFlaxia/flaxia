<script lang="ts">
import { onMount } from 'svelte';
import { ensureBottomNav, getBottomNav } from '../../lib/bottom-nav-setup.ts';
import { leftNavCallbacks } from '../../lib/left-nav-handlers.ts';
import { navigate } from '../../lib/navigation.ts';
import { parseCurrentRoute } from '../../lib/router.ts';
import { viewToBottomNavId, viewToPath } from '../../lib/view-nav.ts';
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
// the first render already has working nav handlers. `mounted` starts false so
// the SSR HTML and the first client render agree (the session is client-only).
let mounted = $state(false);
const fallbackNavProps = () => ({
  activeItem: parseCurrentRoute()?.view ?? 'home',
  currentUser: mounted ? (getSessionUser() ?? undefined) : undefined,
  ...leftNavCallbacks({
    navigate: (view: string, postId?: string, username?: string) => {
      void navigate(viewToPath(view, postId, username));
    },
    getCurrentUsername: () => getSessionUser()?.username ?? null,
  }),
});

void fallbackNavProps;

$effect(() => {
  getBottomNav()?.setActiveItem(viewToBottomNavId(String(navProps.activeItem ?? 'home')));
});

$effect(() => {
  const user = navProps.currentUser;
  getBottomNav()?.updateUser(user as never);
});

onMount(() => {
  mounted = true;
  void ensureBottomNav({
    navigate: (view, postId, username) => {
      void navigate(viewToPath(view, postId, username));
    },
    getCurrentUser: () => navProps.currentUser as never,
    getActiveItem: () => viewToBottomNavId(parseCurrentRoute()?.view ?? ''),
  }).then((nav) => {
    // navProps can resolve while the lazy nav is still loading; re-apply both
    // so the guest/login item never sticks for a signed-in user.
    nav.updateUser((navProps.currentUser as never) ?? null);
    nav.setActiveItem(viewToBottomNavId(String(navProps.activeItem ?? 'home')));
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
