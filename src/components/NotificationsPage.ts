import { t } from '../lib/i18n.js';
import { createPageHeader } from '../lib/page-header.js';

export interface Notification {
  id: string;
  type:
    | 'reported'
    | 'fresh'
    | 'reload'
    | 'warned'
    | 'hidden'
    | 'ap_follow'
    | 'ap_like'
    | 'ap_announce'
    | 'reply'
    | 'mention'
    | 'poll_ended'
    | 'quote';
  post_id: string | null;
  post_text_preview: string | null;
  actor?: {
    username: string;
    display_name: string;
    avatar_key: string | null;
    badge_type?: string | null;
  };
  actors?: Array<{
    username: string;
    display_name: string;
    avatar_key: string | null;
    badge_type?: string | null;
  } | null>;
  actor_id?: string | null;
  actor_data?: string | null; // JSON string for external actor info or grouped actor IDs
  read: boolean;
  created_at: string;
}

export interface NotificationsPageProps {
  notifications: Notification[];
  unreadCount: number;
  onMarkAllRead: () => Promise<void>;
  onNavigateToPost: (postId: string) => void;
}

export class NotificationsPage {
  private element: HTMLElement;
  private props: NotificationsPageProps;

  constructor(props: NotificationsPageProps) {
    this.props = props;
    this.element = this.createElement();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'notifications-page';

    // Header
    const actions: HTMLElement[] = [];

    // Mark all read button (only show if there are unread)
    if (this.props.unreadCount > 0) {
      const markAllBtn = document.createElement('button');
      markAllBtn.className = 'mark-all-read-btn';
      markAllBtn.textContent = t('notifications.mark_all_read');
      markAllBtn.addEventListener('click', async () => {
        markAllBtn.disabled = true;
        await this.props.onMarkAllRead();
        this.updateAllAsRead();
      });
      actions.push(markAllBtn);
    }

    container.appendChild(
      createPageHeader({
        title: t('notifications.title'),
        titleSize: '24px',
        onBack: () => window.history.back(),
        actions,
      }),
    );

    // Notifications list
    if (this.props.notifications.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'notifications-empty fx-display';
      empty.textContent = t('notifications.empty');
      container.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'notifications-list';

      this.props.notifications.forEach((notification) => {
        const row = this.createNotificationRow(notification);
        list.appendChild(row);
      });

      container.appendChild(list);
    }

    return container;
  }

  private createNotificationRow(notification: Notification): HTMLElement {
    const row = document.createElement('div');
    row.className = `notification-row ${notification.read ? 'read' : 'unread'}`;

    // Unread indicator: accent dot with a soft ping ring (decorative).
    if (!notification.read) {
      const dot = document.createElement('span');
      dot.className = 'notification-dot';
      dot.setAttribute('aria-hidden', 'true');
      row.appendChild(dot);
    }

    row.addEventListener('click', () => {
      if (notification.post_id) {
        this.props.onNavigateToPost(notification.post_id);
      }
      // For follow notifications, clicking doesn't navigate to a post
    });

    // Icon
    const icon = document.createElement('div');
    icon.className = 'notification-icon';
    // Vermilion is reserved for "live" moments: fresh/reload reactions.
    if (notification.type === 'fresh' || notification.type === 'ap_like') {
      icon.classList.add('notification-icon--live');
    }
    icon.setAttribute('aria-hidden', 'true');
    switch (notification.type) {
      case 'fresh':
      case 'ap_like':
        icon.textContent = '🌿';
        break;
      case 'reload':
        icon.textContent = '🔁';
        break;
      case 'ap_follow':
        icon.textContent = '👥';
        break;
      case 'ap_announce':
        icon.textContent = '📣';
        break;
      case 'reply':
        icon.textContent = '💬';
        break;
      case 'quote':
        icon.textContent = '🔁';
        break;
      case 'mention':
        icon.textContent = '📢';
        break;
      case 'reported':
        icon.textContent = '🚩';
        break;
      case 'warned':
        icon.textContent = '⚠️';
        break;
      case 'hidden':
        icon.textContent = '🙈';
        break;
      case 'poll_ended':
        icon.textContent = '📊';
        break;
      default:
        icon.textContent = '';
    }
    row.appendChild(icon);

    // Content
    const content = document.createElement('div');
    content.className = 'notification-content';

    // Main text
    const mainText = document.createElement('div');
    mainText.className = 'notification-main';

    const appendMuted = (text: string) => {
      const span = document.createElement('span');
      span.className = 'notification-muted';
      span.textContent = text;
      mainText.appendChild(span);
    };

    const appendStrong = (text: string) => {
      const strong = document.createElement('strong');
      strong.textContent = text;
      mainText.appendChild(strong);
    };

    switch (notification.type) {
      case 'fresh':
      case 'ap_like':
        if (notification.actors && notification.actors.length > 1) {
          // Grouped fresh notification (newest liker first)
          const validActors = notification.actors.filter((a): a is NonNullable<typeof a> => a !== null);
          if (validActors.length > 0) {
            const reversed = [...validActors].reverse();
            reversed.slice(0, 2).forEach((a, i) => {
              if (i > 0) mainText.appendChild(document.createTextNode('、'));
              appendStrong(`@${a.username}`);
              mainText.appendChild(document.createTextNode(' '));
              appendMuted(`(${a.display_name})`);
            });
            const freshKey =
              notification.type === 'fresh' ? 'notifications.freshed_your_post' : 'notifications.liked_your_post';
            mainText.appendChild(document.createTextNode(t(freshKey, { actor: '' })));
          }
        } else if (notification.actor) {
          const freshKey =
            notification.type === 'fresh' ? 'notifications.freshed_your_post' : 'notifications.liked_your_post';
          appendStrong(`@${notification.actor.username}`);
          mainText.appendChild(document.createTextNode(' '));
          appendMuted(`(${notification.actor.display_name})`);
          mainText.appendChild(document.createTextNode(t(freshKey, { actor: '' })));
        }
        break;
      case 'reply':
        if (notification.actors && notification.actors.length > 1) {
          const validActors = notification.actors.filter((a): a is NonNullable<typeof a> => a !== null);
          if (validActors.length > 0) {
            const reversed = [...validActors].reverse();
            reversed.slice(0, 2).forEach((a, i) => {
              if (i > 0) mainText.appendChild(document.createTextNode('、'));
              appendStrong(`@${a.username}`);
              mainText.appendChild(document.createTextNode(' '));
              appendMuted(`(${a.display_name})`);
            });
            mainText.appendChild(document.createTextNode(t('notifications.replied_to_you', { actor: '' })));
          }
        } else if (notification.actor) {
          appendStrong(`@${notification.actor.username}`);
          mainText.appendChild(document.createTextNode(' '));
          appendMuted(`(${notification.actor.display_name})`);
          mainText.appendChild(document.createTextNode(t('notifications.replied_to_you', { actor: '' })));
        }
        break;
      case 'mention':
        if (notification.actor) {
          appendStrong(`@${notification.actor.username}`);
          mainText.appendChild(document.createTextNode(' '));
          appendMuted(`(${notification.actor.display_name})`);
          mainText.appendChild(document.createTextNode(t('notifications.mentioned_you', { actor: '' })));
        }
        break;
      case 'quote':
        if (notification.actor) {
          appendStrong(`@${notification.actor.username}`);
          mainText.appendChild(document.createTextNode(' '));
          appendMuted(`(${notification.actor.display_name})`);
          mainText.appendChild(document.createTextNode(t('notifications.quoted_your_post', { actor: '' })));
        }
        break;
      case 'reload':
        if (notification.actors && notification.actors.length > 1) {
          const validActors = notification.actors.filter((a): a is NonNullable<typeof a> => a !== null);
          if (validActors.length > 0) {
            const reversed = [...validActors].reverse();
            reversed.slice(0, 2).forEach((a, i) => {
              if (i > 0) mainText.appendChild(document.createTextNode('、'));
              appendStrong(`@${a.username}`);
              mainText.appendChild(document.createTextNode(' '));
              appendMuted(`(${a.display_name})`);
            });
            mainText.appendChild(document.createTextNode(t('notifications.reloaded_your_post', { actor: '' })));
          }
        } else if (notification.actor) {
          appendStrong(`@${notification.actor.username}`);
          mainText.appendChild(document.createTextNode(' '));
          appendMuted(`(${notification.actor.display_name})`);
          mainText.appendChild(document.createTextNode(t('notifications.reloaded_your_post', { actor: '' })));
        }
        break;
      case 'ap_follow':
        if (notification.actor) {
          // Local user follow
          appendStrong(`@${notification.actor.username}`);
          mainText.appendChild(document.createTextNode(' '));
          appendMuted(`(${notification.actor.display_name})`);
          mainText.appendChild(document.createTextNode(t('notifications.followed_you', { actor: '' })));
        } else {
          // External actor follow - use actor_data if available
          let actorInfo = null;
          if (notification.actor_data) {
            try {
              actorInfo = JSON.parse(notification.actor_data);
            } catch (e) {
              console.error('Failed to parse actor_data:', e);
            }
          }

          if (actorInfo) {
            // Display as "MastodonのXXXさんがフォローしました"
            const displayName = actorInfo.display_name || actorInfo.username || t('notifications.user_fallback_ja');
            const domain = actorInfo.domain || 'external';
            mainText.textContent = t('notifications.follow_external', { domain, name: displayName });
          } else {
            // Fallback for existing notifications without actor_data
            const actorUrl = notification.actor_id || 'external user';
            const domain = actorUrl.includes('://') ? new URL(actorUrl).hostname : actorUrl;
            mainText.textContent = t('notifications.follow_external_fallback', { domain });
          }
        }
        break;
      case 'ap_announce':
        if (notification.actor) {
          appendStrong(`@${notification.actor.username}`);
          mainText.appendChild(document.createTextNode(' '));
          appendMuted(`(${notification.actor.display_name})`);
          mainText.appendChild(document.createTextNode(t('notifications.boosted_your_post', { actor: '' })));
        } else {
          const actorUrl = notification.actor_id || 'external user';
          const domain = actorUrl.includes('://') ? new URL(actorUrl).hostname : actorUrl;
          mainText.textContent = t('notifications.boost_external', { domain });
        }
        break;
      case 'poll_ended':
        mainText.textContent = t('notifications.poll_ended');
        break;
      default:
        appendStrong(t('notifications.your_post_reported'));
        mainText.appendChild(document.createTextNode(t('notifications.reported_hint_ja')));
    }
    content.appendChild(mainText);

    // Post preview (only for notifications with posts)
    if (notification.post_id && notification.post_text_preview) {
      const preview = document.createElement('div');
      preview.className = 'notification-preview';
      preview.textContent = notification.post_text_preview;
      content.appendChild(preview);
    }

    // Time
    const time = document.createElement('div');
    time.className = 'notification-time';
    time.textContent = this.formatTime(notification.created_at);
    content.appendChild(time);

    row.appendChild(content);

    return row;
  }

  private formatTime(createdAt: string): string {
    const date = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('time.just_now');
    if (diffMins < 60) return t('time.minutes_ago', { n: diffMins });
    if (diffHours < 24) return t('time.hours_ago', { n: diffHours });
    if (diffDays < 7) return t('time.days_ago', { n: diffDays });
    return date.toLocaleDateString();
  }

  private updateAllAsRead(): void {
    const rows = this.element.querySelectorAll('.notification-row');
    rows.forEach((row) => {
      row.classList.remove('unread');
      row.classList.add('read');
      row.querySelector('.notification-dot')?.remove();
    });

    // Remove the "Mark all read" button
    const markAllBtn = this.element.querySelector('.mark-all-read-btn');
    if (markAllBtn) {
      markAllBtn.remove();
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.element.remove();
  }
}

export function createNotificationsPage(props: NotificationsPageProps): NotificationsPage {
  return new NotificationsPage(props);
}
