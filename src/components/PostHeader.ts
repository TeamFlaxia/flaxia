import { attachPlusBadge } from '../lib/avatar.js';
import { t } from '../lib/i18n.js';
import { applyNameColor } from '../lib/name-color.js';
import { nativeApiHref } from '../lib/native-api.js';
import { setOfflineImage } from '../lib/offline-image.js';
import { createUserTitleBadge } from '../lib/user-title.js';
import { PostHeaderProps } from '../types/post.js';

export function createPostHeader(props: PostHeaderProps & { editedAt?: string }): HTMLElement {
  const header = document.createElement('div');
  header.className = 'post-header';

  // Outer element paints the gradient ring; the inner disc holds the
  // initials or the lazily loaded photo, so the ring survives both.
  const avatar = document.createElement('div');
  avatar.className = 'post-avatar';

  const avatarInner = document.createElement('div');
  avatarInner.className = 'post-avatar-inner';

  // 優先的に初期文字を表示（アバター画像は後で非同期読み込み）
  const initial = document.createElement('span');
  initial.className = 'avatar-initial';
  initial.textContent = props.username.charAt(0).toUpperCase();
  avatarInner.appendChild(initial);

  avatar.appendChild(avatarInner);

  attachPlusBadge(avatar, props.badge_type);

  // アバター画像は遅延読み込み（テキスト表示を優先）
  if (props.avatar_url) {
    scheduleAvatarLoad(() => loadAvatarUrl(avatarInner, props.avatar_url!));
  } else if (props.avatar_key) {
    scheduleAvatarLoad(() => loadAvatarImage(avatarInner, props.avatar_key!));
  }

  const displayName = document.createElement('span');
  displayName.className = 'post-display-name';
  displayName.textContent = props.display_name || props.username;
  applyNameColor(displayName, props.name_color, props.badge_type);

  const username = document.createElement('span');
  username.className = 'post-username';
  username.textContent = `@${props.username}`;

  const timestamp = document.createElement('span');
  timestamp.className = 'post-timestamp';
  timestamp.textContent = formatTimestamp(props.createdAt);
  if (props.editedAt) {
    const editedBadge = document.createElement('span');
    editedBadge.className = 'post-edited-badge';
    editedBadge.textContent = t('post.edited');
    timestamp.appendChild(editedBadge);
  }

  header.appendChild(avatar);
  header.appendChild(displayName);
  header.appendChild(username);
  const titleBadge = createUserTitleBadge(props);
  if (titleBadge) header.appendChild(titleBadge);
  header.appendChild(timestamp);

  // Make avatar and names clickable to navigate to profile. A remote actor
  // lives on another instance, so its profile opens there.
  const navigateToProfile = () => {
    if (props.profile_url) {
      window.open(props.profile_url, '_blank', 'noopener,noreferrer');
      return;
    }
    window.history.pushState({}, '', `/profile/${props.username}`);
    window.dispatchEvent(
      new CustomEvent('spaNavigate', {
        detail: { view: 'profile', username: props.username },
      }),
    );
  };

  avatar.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateToProfile();
  });

  displayName.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateToProfile();
  });

  username.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateToProfile();
  });

  return header;
}

function scheduleAvatarLoad(load: () => void): void {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback?.(load, { timeout: 1000 });
  } else {
    setTimeout(load, 100);
  }
}

function loadAvatarUrl(avatarInner: HTMLElement, url: string): void {
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.onload = () => {
    avatarInner.style.backgroundImage = `url(${img.src})`;
    avatarInner.style.backgroundSize = 'cover';
    avatarInner.style.backgroundPosition = 'center';
    avatarInner.querySelector(':scope > .avatar-initial')?.remove();
  };
  img.onerror = () => {
    // Keep the initial letter when the remote image is unavailable.
  };
  img.src = url;
}

// アバター画像を非同期で読み込む関数
function loadAvatarImage(avatarInner: HTMLElement, avatarKey: string): void {
  const img = new Image();
  img.onload = () => {
    // 画像読み込み完了後に背景画像を設定
    avatarInner.style.backgroundImage = 'url(' + img.src + ')';
    avatarInner.style.backgroundSize = 'cover';
    avatarInner.style.backgroundPosition = 'center';
    // Clear only the initial letter — keep the badge element.
    avatarInner.querySelector(':scope > .avatar-initial')?.remove();
  };
  img.onerror = () => {
    // 読み込み失敗時は初期文字のまま
    console.warn(`Failed to load avatar: ${avatarKey}`);
  };
  setOfflineImage(img, nativeApiHref(`/api/images/${avatarKey}`));
}

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return t('post_header.now');
  if (diffMins < 60) return t('post_header.minutes', { n: diffMins });
  if (diffHours < 24) return t('post_header.hours', { n: diffHours });
  if (diffDays < 7) return t('post_header.days', { n: diffDays });

  return date.toLocaleDateString();
}
