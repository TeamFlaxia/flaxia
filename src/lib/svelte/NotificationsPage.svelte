<script lang="ts">
import type { Notification } from '../../components/NotificationsPage.ts';
import { t } from '../i18n.ts';
import { type IconName, icon } from '../icons.ts';
import {
  formatNotificationTime,
  iconForNotification,
  isLiveNotification,
  notificationSegments,
} from '../notifications/format.ts';

let {
  notifications,
  unreadCount,
  onMarkAllRead,
  onNavigateToPost,
}: {
  notifications: Notification[];
  unreadCount: number;
  onMarkAllRead: () => Promise<void>;
  onNavigateToPost: (postId: string) => void;
} = $props();

let unread = $state(unreadCount);
let busy = $state(false);
let rows = $state(notifications);

function iconHtml(name: IconName): string {
  return icon(name, { width: '16', height: '16' }).outerHTML;
}

async function markAll(): Promise<void> {
  if (busy) return;
  busy = true;
  await onMarkAllRead();
  rows = rows.map((n) => ({ ...n, read: true }));
  unread = 0;
  busy = false;
}

function open(n: Notification): void {
  if (n.post_id) onNavigateToPost(n.post_id);
}
</script>

<div class="notifications-page">
  <div class="page-header" style="--page-header-title-size: 24px;">
    <button type="button" class="page-header-back" aria-label="Back" onclick={() => window.history.back()}>←</button>
    <div class="page-header-titles">
      <h1 class="page-header-title fx-display">{t('notifications.title')}</h1>
    </div>
    {#if unread > 0}
      <div class="page-header-actions">
        <button type="button" class="mark-all-read-btn" disabled={busy} onclick={markAll}>
          {t('notifications.mark_all_read')}
        </button>
      </div>
    {/if}
  </div>

  {#if rows.length === 0}
    <div class="notifications-empty fx-display">{t('notifications.empty')}</div>
  {:else}
    <div class="notifications-list">
      {#each rows as n (n.id)}
        {@const iconName = iconForNotification(n.type)}
        <div class="notification-row {n.read ? 'read' : 'unread'}" onclick={() => open(n)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') open(n); }}>
          {#if !n.read}
            <span class="notification-dot" aria-hidden="true"></span>
          {/if}
          <div class="notification-icon" class:notification-icon--live={isLiveNotification(n.type)} aria-hidden="true">
            {#if iconName}{@html iconHtml(iconName)}{/if}
          </div>
          <div class="notification-content">
            <div class="notification-main">
              {#each notificationSegments(n) as seg}
                {#if seg.kind === 'strong'}<strong>{seg.text}</strong>{:else if seg.kind === 'muted'}<span class="notification-muted">{seg.text}</span>{:else}{seg.text}{/if}
              {/each}
            </div>
            {#if n.post_id && n.post_text_preview}
              <div class="notification-preview">{n.post_text_preview}</div>
            {/if}
            <div class="notification-time">{formatNotificationTime(n.created_at)}</div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
