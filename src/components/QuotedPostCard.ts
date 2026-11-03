import { attachPlusBadge } from '../lib/avatar.js';
import { canUsePostColors } from '../lib/entitlements.js';
import { t } from '../lib/i18n.js';
import { applyNameColor } from '../lib/name-color.js';
import { nativeApiHref } from '../lib/native-api.js';
import { parsePostColors } from '../lib/post-colors.js';
import { renderColorizedText } from '../lib/post-colors-dom.js';
import { createUserTitleBadge } from '../lib/user-title.js';
import type { QuotedPost } from '../types/post.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { createImagePreview } from './ImagePreview.js';
import { createMediaCarousel } from './MediaCarousel.js';
import { isZipGame, stripLeadingEmoji } from './PostStage.js';
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
      if (quoted.swf_key?.startsWith('swf/')) badge.textContent = stripLeadingEmoji(t('post_stage.play_flash'));
      else badge.textContent = stripLeadingEmoji(t('post_stage.run_zip'));
      wrap.appendChild(badge);
    }
    return wrap;
  }

  if (isExecutable) {
    const pill = document.createElement('div');
    pill.className = 'quoted-post-attachment-pill';
    if (quoted.swf_key?.startsWith('swf/')) pill.textContent = stripLeadingEmoji(t('post_stage.click_play_flash'));
    else pill.textContent = stripLeadingEmoji(t('post_stage.click_to_run'));
    wrap.appendChild(pill);
    return wrap;
  }

  return null;
}

export function createQuotedPostCard(props: QuotedPostCardProps): HTMLElement {
  const { quoted, disableNavigation, onNavigateToThread } = props;

  const card = document.createElement('div');
  card.className = 'quoted-post-card';
  card.style.cursor = disableNavigation ? 'default' : 'pointer';

  if (!quoted) {
    const unavailable = document.createElement('div');
    unavailable.className = 'quoted-post-unavailable';
    unavailable.textContent = t('post.quote_unavailable');
    card.appendChild(unavailable);
    return card;
  }

  const navigate = () => onNavigateToThread(quoted.id);

  card.addEventListener('click', (e) => {
    e.stopPropagation();
    navigate();
  });

  if (!disableNavigation) {
    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      navigate();
    });
  }

  const nameRow = document.createElement('div');
  nameRow.className = 'quoted-post-author';

  const avatar = document.createElement('span');
  avatar.className = 'quoted-post-avatar';
  if (quoted.avatar_key) {
    avatar.style.backgroundImage = `url(${nativeApiHref(`/api/images/${quoted.avatar_key}`)})`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
  } else {
    avatar.textContent = (quoted.display_name || quoted.username || '?').charAt(0).toUpperCase();
  }
  attachPlusBadge(avatar, quoted.badge_type);

  const name = document.createElement('span');
  name.className = 'quoted-post-name';
  name.textContent = quoted.display_name || quoted.username || '';
  applyNameColor(name, quoted.name_color, quoted.badge_type);

  const username = document.createElement('span');
  username.className = 'quoted-post-username';
  username.textContent = quoted.username ? `@${quoted.username}` : '';

  nameRow.appendChild(avatar);
  nameRow.appendChild(name);
  nameRow.appendChild(username);
  const titleBadge = createUserTitleBadge(quoted);
  if (titleBadge) nameRow.appendChild(titleBadge);
  card.appendChild(nameRow);

  const body = document.createElement('div');
  body.className = 'quoted-post-text';
  if (canUsePostColors({ badge_type: quoted.badge_type })) {
    const parsed = parsePostColors(quoted.text || '');
    body.appendChild(renderColorizedText(parsed.plain, parsed.spans));
  } else {
    body.textContent = (quoted.text || '').replace(/\\\{/g, '{');
  }
  card.appendChild(body);

  const attachment = createQuotedPostAttachment(quoted);
  if (attachment) card.appendChild(attachment);

  return card;
}
