'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';


interface Notification {
  id: string;
  type: string;
  actor_username?: string;
  actor_display_name?: string;
  actor_avatar_key?: string;
  post_id?: string;
  post_text?: string;
  is_read: boolean;
  created_at: string;
  actor_data?: string;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

function getNotificationText(n: Notification, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const actor = n.actor_display_name || n.actor_username || '';
  switch (n.type) {
    case 'fresh': return t('notifications.fresh', { user: actor });
    case 'reply': return t('notifications.reply', { user: actor });
    case 'mention': return t('notifications.mention', { user: actor });
    case 'follow': return t('notifications.follow', { user: actor });
    case 'ap_like': return t('notifications.ap_like', { user: actor });
    case 'ap_follow': return t('notifications.ap_follow', { user: actor });
    case 'ap_announce': return t('notifications.ap_announce', { user: actor });
    case 'reported': return t('notifications.reported');
    case 'warned': return t('notifications.warned');
    case 'hidden': return t('notifications.hidden');
    case 'poll_ended': return t('notifications.poll_ended');
    default: return n.type;
  }
}

function getNotificationIcon(type: string): string {
  switch (type) {
    case 'fresh': return '\u2764\ufe0f';
    case 'reply': return '\u{1f4ac}';
    case 'mention': return '@';
    case 'follow': return '\u{1f464}';
    case 'ap_like': return '\u2764\ufe0f';
    case 'ap_follow': return '\u{1f464}';
    case 'ap_announce': return '\u{1f504}';
    case 'reported': return '\u26a0\ufe0f';
    case 'warned': return '\u26a0\ufe0f';
    case 'hidden': return '\u{1f6ab}';
    case 'poll_ended': return '\u{1f4ca}';
    default: return '\u{1f514}';
  }
}

export default function NotificationsPage() {
  const router = useRouter();
  const { currentUser } = useAuth();
  const { t } = useI18n();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentUser) { setLoading(false); return; }
    (async () => {
      try {
        const res = await fetch('/api/notifications', { credentials: 'include' });
        const data = res.ok ? (await res.json()) as { notifications?: Notification[] } : { notifications: [] };
        setNotifications(data.notifications || []);
      } catch (err) { console.error(err); }
      finally { setLoading(false); }
    })();
  }, [currentUser]);

  const markAllRead = useCallback(async () => {
    try {
      await fetch('/api/notifications/read', { method: 'POST', credentials: 'include' });
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    } catch {}
  }, []);

  const openNotification = useCallback((n: Notification) => {
    if (n.post_id) router.push(`/thread/${n.post_id}`);
    else if (n.type === 'follow' || n.type === 'ap_follow') {
      const actor = n.actor_data ? JSON.parse(n.actor_data) : null;
      if (actor?.url) window.open(actor.url, '_blank');
    }
  }, [router]);

  if (!currentUser) {
    return (
      <div className="notifications-page">
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          {t('notifications.sign_in_required')}
        </div>
      </div>
    );
  }

  const unreadCount = notifications.filter(n => !n.is_read).length;

  return (
    <div className="notifications-page">
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 1rem' }}>
          <h1 style={{ fontSize: '1.25rem', margin: 0 }}>{t('notifications.title')}</h1>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              style={{
                padding: '0.25rem 0.75rem', borderRadius: 9999, border: '1px solid var(--border)',
                background: 'none', cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-primary)',
              }}
            >
              {t('notifications.mark_all_read')}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('common.loading')}</div>
      ) : notifications.length === 0 ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>{t('notifications.empty')}</div>
      ) : (
        <div>
          {notifications.map(n => (
            <div
              key={n.id}
              onClick={() => openNotification(n)}
              style={{
                display: 'flex', gap: '0.75rem', padding: '0.75rem 1rem',
                background: n.is_read ? 'var(--bg-primary)' : 'var(--bg-secondary)',
                cursor: n.post_id ? 'pointer' : 'default',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div style={{ fontSize: '1.25rem', flexShrink: 0, width: 24, textAlign: 'center' }}>
                {getNotificationIcon(n.type)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                  {getNotificationText(n, t)}
                </div>
                {n.post_text && (
                  <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.25rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {n.post_text}
                  </div>
                )}
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                  {formatRelativeTime(n.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
