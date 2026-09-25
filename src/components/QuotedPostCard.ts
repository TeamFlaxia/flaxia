import { attachPlusBadge } from '../lib/avatar.js';
import { t } from '../lib/i18n.js';
import type { QuotedPost } from '../types/post.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { createImagePreview } from './ImagePreview.js';
import { createMediaCarousel } from './MediaCarousel.js';
import { isZipGame } from './PostStage.js';
import { createVideoPlayer } from './VideoPlayer.js';

export interface QuotedPostCardProps {
  quoted: QuotedPost | null;
  disableNavigation?: boolean;
  onNavigateToThread: (postId: string) => void;
}

function createQuotedPostAttachment(quoted: QuotedPost): HTMLElement | null {
  if (
    !quoted.gif_key &&
    !quoted.payload_key &&
    !quoted.swf_key &&
    !quoted.thumbnail_key &&
    !(quoted.attachments && quoted.attachments.length > 0)
  ) {
    return null;
  }

  const wrap = document.createElement('div');
  wrap.className = 'quoted-post-attachment';
  wrap.style.cssText = `
    margin-top: 0.5rem;
    border-radius: 0.5rem;
    overflow: hidden;
    position: relative;
  `;

  if (quoted.attachments && quoted.attachments.length > 0) {
    wrap.appendChild(createMediaCarousel({ postId: quoted.id, attachments: quoted.attachments }));
    return wrap;
  }

  const gifKey = quoted.gif_key || '';
  if (gifKey.startsWith('video/')) {
    wrap.appendChild(createVideoPlayer({ gifKey, postId: quoted.id }));
    return wrap;
  }
  if (gifKey.startsWith('audio/')) {
    wrap.appendChild(createAudioPlayer({ gifKey: gifKey, postId: quoted.id }));
    return wrap;
  }
  if (gifKey) {
    wrap.appendChild(createImagePreview({ gifKey, postId: quoted.id, ratio: '16:9' }));
    return wrap;
  }

  const isExecutable = isZipGame(quoted.payload_key) || (!!quoted.swf_key && quoted.swf_key.startsWith('swf/'));

  if (quoted.thumbnail_key) {
    wrap.appendChild(
      createImagePreview({
        gifKey: quoted.thumbnail_key,
        postId: quoted.id,
        isThumbnail: true,
        ratio: '16:9',
      }),
    );
    if (isExecutable) {
      const badge = document.createElement('div');
      badge.className = 'quoted-post-attachment-badge';
      badge.style.cssText = `
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.7);
        color: #fff;
        padding: 6px 14px;
        border-radius: 20px;
        font-size: 0.85rem;
        font-weight: 600;
        pointer-events: none;
      `;
      if (quoted.swf_key?.startsWith('swf/')) badge.textContent = t('post_stage.play_flash');
      else badge.textContent = t('post_stage.run_zip');
      wrap.appendChild(badge);
    }
    return wrap;
  }

  if (isExecutable) {
    const pill = document.createElement('div');
    pill.style.cssText = `
      padding: 0.75rem;
      border-radius: 0.5rem;
      background: var(--bg-secondary);
      color: var(--text-muted);
      font-size: 0.85rem;
      font-weight: 600;
      text-align: center;
    `;
    if (quoted.swf_key?.startsWith('swf/')) pill.textContent = t('post_stage.click_play_flash');
    else pill.textContent = t('post_stage.click_to_run');
    wrap.appendChild(pill);
    return wrap;
  }

  return null;
}

export function createQuotedPostCard(props: QuotedPostCardProps): HTMLElement {
  const { quoted, disableNavigation, onNavigateToThread } = props;

  const card = document.createElement('div');
  card.className = 'quoted-post-card';
  card.style.cssText = `
    margin: 0 0 1rem 0;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.75rem;
    cursor: ${disableNavigation ? 'default' : 'pointer'};
    background: var(--bg-secondary, rgba(0,0,0,0.02));
  `;

  if (!quoted) {
    const unavailable = document.createElement('div');
    unavailable.className = 'quoted-post-unavailable';
    unavailable.style.cssText = `
      color: var(--text-muted);
      font-size: 0.85rem;
      font-style: italic;
    `;
    unavailable.textContent = t('post.quote_unavailable');
    card.appendChild(unavailable);
    return card;
  }

  card.addEventListener('click', (e) => {
    e.stopPropagation();
    onNavigateToThread(quoted.id);
  });

  const nameRow = document.createElement('div');
  nameRow.className = 'quoted-post-author';
  nameRow.style.cssText = `
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.25rem;
  `;

  const avatar = document.createElement('span');
  avatar.className = 'quoted-post-avatar';
  avatar.style.cssText = `
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 600;
    color: #fff;
    background: var(--accent);
    flex-shrink: 0;
    overflow: visible;
  `;
  if (quoted.avatar_key) {
    avatar.style.backgroundImage = `url(/api/images/${quoted.avatar_key})`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
    avatar.textContent = '';
  } else {
    avatar.textContent = (quoted.display_name || quoted.username || '?').charAt(0).toUpperCase();
  }
  attachPlusBadge(avatar, quoted.badge_type);

  const name = document.createElement('span');
  name.className = 'quoted-post-name';
  name.style.cssText = `
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
  `;
  name.textContent = quoted.display_name || quoted.username || '';

  const username = document.createElement('span');
  username.className = 'quoted-post-username';
  username.style.cssText = `
    font-size: 0.8rem;
    color: var(--text-muted);
  `;
  username.textContent = quoted.username ? `@${quoted.username}` : '';

  nameRow.appendChild(avatar);
  nameRow.appendChild(name);
  nameRow.appendChild(username);
  card.appendChild(nameRow);

  const body = document.createElement('div');
  body.className = 'quoted-post-text';
  body.style.cssText = `
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  `;
  body.textContent = quoted.text || '';
  card.appendChild(body);

  const attachment = createQuotedPostAttachment(quoted);
  if (attachment) card.appendChild(attachment);

  return card;
}
