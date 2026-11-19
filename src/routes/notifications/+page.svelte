<script lang="ts">
import { onMount } from 'svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';

let host: HTMLDivElement;
let navProps = $state<Record<string, unknown>>({});

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
    const { fetchNotifications, invalidateNotificationsCache } = await import('../../lib/notifications-api.ts');
    await initI18n();
    const user = getSessionUser();
    if (!user) {
      window.location.replace('/explore');
      return;
    }
    const currentUser = user as Parameters<
      typeof import('../../components/NotificationsPage.ts')['createNotificationsPage']
    >[0]['currentUser'];
    const data = await fetchNotifications();
    const { createNotificationsPage } = await import('../../components/NotificationsPage.ts');
    const page = createNotificationsPage({
      notifications: data.notifications,
      unreadCount: data.unread_count,
      currentUser,
      onMarkAllRead: async () => {
        await fetch('/api/notifications/read-all', { method: 'POST', credentials: 'include' });
        invalidateNotificationsCache();
        const { clearNativeBadge } = await import('../../lib/native-notify.ts');
        await clearNativeBadge();
        navProps = { ...navProps, unreadCount: 0 };
      },
      onNavigateToPost: (postId: string) => window.location.assign(`/thread/${postId}`),
    });
    host.appendChild(page.getElement());
    dispose = page.destroy;
    navProps = {
      activeItem: 'notifications',
      unreadCount: data.unread_count,
      currentUser,
      ...createLeftNavHandlers({
        navigate: (view, postId, username) => window.location.assign(pathFor(view, postId, username)),
        getCurrentUsername: () => (currentUser?.username as string | undefined) ?? null,
      }),
    };
  })();
  return () => dispose();
});
</script>

<ShellLayout {navProps}>
  <div bind:this={host}></div>
</ShellLayout>
