// Pure formatting helpers for the notification feed, shared with the Svelte
// rewrite. Keeps the legacy copy and grouping rules in one testable place.

import { t } from '../i18n.ts';
import type { IconName } from '../icons.ts';
import type { Notification } from './types.ts';

export type TextSegment = { text: string; kind: 'strong' | 'muted' | 'text' };

const text = (value: string): TextSegment => ({ text: value, kind: 'text' });
const strong = (value: string): TextSegment => ({ text: value, kind: 'strong' });
const muted = (value: string): TextSegment => ({ text: value, kind: 'muted' });

export function iconForNotification(type: Notification['type']): IconName | null {
  switch (type) {
    case 'fresh':
    case 'ap_like':
      return 'fresh';
    case 'reload':
      return 'reload';
    case 'ap_follow':
      return 'users';
    case 'ap_announce':
      return 'megaphone';
    case 'reply':
      return 'reply';
    case 'quote':
      return 'quote';
    case 'mention':
      return 'at-sign';
    case 'reported':
      return 'flag';
    case 'warned':
      return 'warning';
    case 'hidden':
      return 'eye-off';
    case 'poll_ended':
      return 'poll';
    default:
      return null;
  }
}

export function isLiveNotification(type: Notification['type']): boolean {
  return type === 'fresh' || type === 'ap_like';
}

function actorSegments(actor: { username: string; display_name: string }): TextSegment[] {
  return [strong(`@${actor.username}`), text(' '), muted(`(${actor.display_name})`)];
}

function groupedActors(actors: Notification['actors']): Array<{ username: string; display_name: string }> {
  const valid = (actors ?? []).filter((a): a is NonNullable<typeof a> => a !== null);
  return [...valid].reverse().slice(0, 2);
}

function groupedSegments(actors: Notification['actors']): TextSegment[] {
  const out: TextSegment[] = [];
  groupedActors(actors).forEach((actor, i) => {
    if (i > 0) out.push(text('、'));
    out.push(...actorSegments(actor));
  });
  return out;
}

function domainFromActorId(actorId: string | null | undefined): string {
  const actorUrl = actorId || 'external user';
  return actorUrl.includes('://') ? new URL(actorUrl).hostname : actorUrl;
}

export function notificationSegments(n: Notification): TextSegment[] {
  switch (n.type) {
    case 'fresh':
    case 'ap_like': {
      const key = n.type === 'fresh' ? 'notifications.freshed_your_post' : 'notifications.liked_your_post';
      if (n.actors && n.actors.length > 1) {
        const parts = groupedSegments(n.actors);
        return parts.length ? [...parts, text(t(key, { actor: '' }))] : [];
      }
      return n.actor ? [...actorSegments(n.actor), text(t(key, { actor: '' }))] : [];
    }
    case 'reply': {
      const key = 'notifications.replied_to_you';
      if (n.actors && n.actors.length > 1) {
        const parts = groupedSegments(n.actors);
        return parts.length ? [...parts, text(t(key, { actor: '' }))] : [];
      }
      return n.actor ? [...actorSegments(n.actor), text(t(key, { actor: '' }))] : [];
    }
    case 'reload': {
      const key = 'notifications.reloaded_your_post';
      if (n.actors && n.actors.length > 1) {
        const parts = groupedSegments(n.actors);
        return parts.length ? [...parts, text(t(key, { actor: '' }))] : [];
      }
      return n.actor ? [...actorSegments(n.actor), text(t(key, { actor: '' }))] : [];
    }
    case 'mention':
      return n.actor ? [...actorSegments(n.actor), text(t('notifications.mentioned_you', { actor: '' }))] : [];
    case 'quote':
      return n.actor ? [...actorSegments(n.actor), text(t('notifications.quoted_your_post', { actor: '' }))] : [];
    case 'ap_follow': {
      if (n.actor) return [...actorSegments(n.actor), text(t('notifications.followed_you', { actor: '' }))];
      let info: { display_name?: string; username?: string; domain?: string } | null = null;
      if (n.actor_data) {
        try {
          info = JSON.parse(n.actor_data);
        } catch {
          info = null;
        }
      }
      if (info) {
        const name = info.display_name || info.username || t('notifications.user_fallback_ja');
        return [text(t('notifications.follow_external', { domain: info.domain || 'external', name }))];
      }
      return [text(t('notifications.follow_external_fallback', { domain: domainFromActorId(n.actor_id) }))];
    }
    case 'ap_announce': {
      if (n.actor) return [...actorSegments(n.actor), text(t('notifications.boosted_your_post', { actor: '' }))];
      return [text(t('notifications.boost_external', { domain: domainFromActorId(n.actor_id) }))];
    }
    case 'poll_ended':
      return [text(t('notifications.poll_ended'))];
    default:
      return [strong(t('notifications.your_post_reported')), text(t('notifications.reported_hint_ja'))];
  }
}

export function formatNotificationTime(createdAt: string, now: Date = new Date()): string {
  const date = new Date(createdAt);
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
