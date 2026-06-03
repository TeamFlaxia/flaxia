import { t } from '../lib/i18n.js';
import { PostHeaderProps } from '../types/post.js';

export function createPostHeader(props: PostHeaderProps): HTMLElement {
  const header = document.createElement('div');
  header.className = 'post-header';

  const avatar = document.createElement('div');
  avatar.className = 'post-avatar';
  avatar.style.cursor = 'pointer';
  avatar.style.width = '40px';
  avatar.style.height = '40px';
  avatar.style.borderRadius = '50%';
  avatar.style.display = 'flex';
  avatar.style.alignItems = 'center';
  avatar.style.justifyContent = 'center';
  avatar.style.fontSize = '1.2rem';
  avatar.style.color = 'white';
  avatar.style.background = 'var(--accent)';
  avatar.style.flexShrink = '0';

  // 優先的に初期文字を表示（アバター画像は後で非同期読み込み）
  avatar.textContent = props.username.charAt(0).toUpperCase();

  // アバター画像は遅延読み込み（テキスト表示を優先）
  if (props.avatar_key) {
    // requestIdleCallback を使ってアイコン読み込みを遅延
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback?.(
        () => {
          loadAvatarImage(avatar, props.avatar_key!);
        },
        { timeout: 1000 },
      );
    } else {
      // フォールバック：setTimeoutで遅延読み込み
      setTimeout(() => {
        loadAvatarImage(avatar, props.avatar_key!);
      }, 100);
    }
  }

  const displayName = document.createElement('span');
  displayName.className = 'post-display-name';
  displayName.textContent = props.display_name || props.username;
  displayName.style.cursor = 'pointer';
  displayName.style.fontWeight = 'bold';

  const username = document.createElement('span');
  username.className = 'post-username';
  username.textContent = `@${props.username}`;
  username.style.cursor = 'pointer';
  username.style.color = 'var(--text-muted)';
  username.style.marginLeft = '0.5rem';

  const timestamp = document.createElement('span');
  timestamp.className = 'post-timestamp';
  timestamp.textContent = formatTimestamp(props.createdAt);

  header.appendChild(avatar);
  header.appendChild(displayName);
  header.appendChild(username);
  header.appendChild(timestamp);

  // Make avatar and names clickable to navigate to profile
  const navigateToProfile = () => {
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

// アバター画像を非同期で読み込む関数
function loadAvatarImage(avatar: HTMLElement, avatarKey: string): void {
  const img = new Image();
  img.onload = () => {
    // 画像読み込み完了後に背景画像を設定
    avatar.style.backgroundImage = `url(/api/images/${avatarKey})`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
    avatar.textContent = '';
  };
  img.onerror = () => {
    // 読み込み失敗時は初期文字のまま
    console.warn(`Failed to load avatar: ${avatarKey}`);
  };
  img.src = `/api/images/${avatarKey}`;
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
