<script lang="ts">
import { onMount } from 'svelte';
import { applyNameColor } from '../../../shared/name-color.ts';
import type { PostHeaderProps } from '../../../shared/types/post.ts';
import { attachPlusBadge } from '../avatar.ts';
import { t } from '../i18n.ts';
import { nativeApiHref } from '../native-api.ts';
import { navigate } from '../navigation.ts';
import { setOfflineImage } from '../offline-image.ts';
import { mountTitleBadge } from '../post/header-badge.ts';

let props: PostHeaderProps & { editedAt?: string } = $props();

let avatar: HTMLDivElement;
let avatarInner: HTMLDivElement;
let displayName: HTMLSpanElement;
let badgeHost: HTMLSpanElement;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return t('post_header.now');
  if (diffMins < 60) return t('post_header.minutes', { n: diffMins });
  if (diffHours < 24) return t('post_header.hours', { n: diffHours });
  if (diffDays < 7) return t('post_header.days', { n: diffDays });
  return date.toLocaleDateString();
}

function goToProfile(): void {
  // Federated authors have a local profile path: navigate inside the app so
  // the session, timeline and back stack keep working. Older payloads only
  // carry an actor URL, which still opens externally as a fallback.
  if (props.profile_path) {
    void navigate(props.profile_path);
    return;
  }
  if (props.profile_url) {
    window.open(props.profile_url, '_blank', 'noopener,noreferrer');
    return;
  }
  void navigate(`/profile/${props.username}`);
}

function onProfileClick(e: MouseEvent): void {
  e.stopPropagation();
  goToProfile();
}

onMount(() => {
  attachPlusBadge(avatar, (props.badge_type as never) ?? null);
  applyNameColor(displayName, (props.name_color as never) ?? null, (props.badge_type as never) ?? null);
  if (badgeHost) mountTitleBadge(badgeHost, props);

  const load = () => {
    if (props.avatar_url) {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        if (!avatarInner) return;
        avatarInner.style.backgroundImage = `url(${img.src})`;
        avatarInner.style.backgroundSize = 'cover';
        avatarInner.style.backgroundPosition = 'center';
        avatarInner.querySelector(':scope > .avatar-initial')?.remove();
      };
      img.src = props.avatar_url;
    } else if (props.avatar_key) {
      const img = new Image();
      img.onload = () => {
        if (!avatarInner) return;
        avatarInner.style.backgroundImage = `url(${img.src})`;
        avatarInner.style.backgroundSize = 'cover';
        avatarInner.style.backgroundPosition = 'center';
        avatarInner.querySelector(':scope > .avatar-initial')?.remove();
      };
      setOfflineImage(img, nativeApiHref(`/api/images/${props.avatar_key}`));
    }
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback?.(load, { timeout: 1000 });
  else setTimeout(load, 100);
});
</script>

<div class="post-header">
  <div bind:this={avatar} class="post-avatar" onclick={onProfileClick} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') onProfileClick(e); }}>
    <div bind:this={avatarInner} class="post-avatar-inner"><span class="avatar-initial">{props.username.charAt(0).toUpperCase()}</span></div>
  </div><span bind:this={displayName} class="post-display-name" onclick={onProfileClick} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') onProfileClick(e); }}>{props.display_name || props.username}</span><span class="post-username" onclick={onProfileClick} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') onProfileClick(e); }}>@{props.username}</span><span bind:this={badgeHost} class="post-title-badge-host"></span><span class="post-timestamp">{formatTimestamp(props.createdAt)}{#if props.editedAt}<span class="post-edited-badge">{t('post.edited')}</span>{/if}</span>
</div>
