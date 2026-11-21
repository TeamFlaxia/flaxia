<script lang="ts">
import { onMount } from 'svelte';
import type { Notification } from '../../components/NotificationsPage.ts';
import { navigate } from '../../lib/navigation.ts';
import { fetchNotifications, invalidateNotificationsCache } from '../../lib/notifications-api.ts';
import NotificationsPage from '../../lib/svelte/NotificationsPage.svelte';
// biome-ignore lint/correctness/noUnusedImports: rendered in markup
import ShellLayout from '../../lib/svelte/ShellLayout.svelte';
import { getSessionUser } from '../../lib/svelte/session.ts';

let notifications = $state<Notification[]>([]);
let unreadCount = $state(0);
let currentUser = $state<Record<string, unknown> | null>(null);
let ready = $state(false);

onMount(() => {
  void (async () => {
    const user = getSessionUser();
    if (!user) {
      void navigate('/explore', { replaceState: true });
      return;
    }
    currentUser = user as unknown as Record<string, unknown>;
    try {
      const data = await fetchNotifications();
      notifications = data.notifications as Notification[];
      unreadCount = data.unread_count;
    } catch {
      notifications = [];
      unreadCount = 0;
    }
    ready = true;
  })();
});

async function markAllRead(): Promise<void> {
  await fetch('/api/notifications/read-all', { method: 'POST', credentials: 'include' });
  invalidateNotificationsCache();
  const { clearNativeBadge } = await import('../../lib/native-notify.ts');
  await clearNativeBadge();
  unreadCount = 0;
}
</script>

<ShellLayout navProps={{ activeItem: 'notifications', unreadCount, currentUser }}>
  {#if ready}
    <NotificationsPage
      {notifications}
      {unreadCount}
      onMarkAllRead={markAllRead}
      onNavigateToPost={(postId) => void navigate(`/thread/${postId}`)}
    />
  {:else}
    <div class="notifications-empty fx-display">{''}</div>
  {/if}
</ShellLayout>
