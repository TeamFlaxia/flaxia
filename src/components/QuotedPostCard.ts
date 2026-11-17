import { attachPlusBadge } from '../lib/avatar.js';
import { canUsePostColors } from '../lib/entitlements.js';
import { t } from '../lib/i18n.js';
import { applyNameColor } from '../lib/name-color.js';
import { nativeApiHref } from '../lib/native-api.js';
import { parsePostColors } from '../lib/post-colors.js';
import { renderColorizedText } from '../lib/post-colors-dom.js';
import { parseMediaCues, stripMediaCues } from '../lib/post-cues.js';
import { html, mount } from '../lib/render/index.ts';
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

  const mediaCues = parseMediaCues(quoted.text || '').cues;
  const cues = mediaCues.length > 0 ? mediaCues : undefined;

  if (quoted.attachments && quoted.attachments.length > 0) {
    wrap.appendChild(createMediaCarousel({ postId: quoted.id, attachments: quoted.attachments, cues }));
    return wrap;
  }

  const gifKey = quoted.gif_key || '';
  if (gifKey.startsWith('video/')) {
    wrap.appendChild(createVideoPlayer({ gifKey, postId: quoted.id, cues }));
    return wrap;
  }
  if (gifKey.startsWith('audio/')) {
    wrap.appendChild(createAudioPlayer({ gifKey: gifKey, postId: quoted.id, cues }));
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
    mount(card, () => html`<div class="quoted-post-unavailable">${t('post.quote_unavailable')}</div>`);
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

  const avatarImage = quoted.avatar_url
    ? quoted.avatar_url
    : quoted.avatar_key
      ? nativeApiHref(`/api/images/${quoted.avatar_key}`)
      : null;
  const avatarInitial = avatarImage ? '' : (quoted.display_name || quoted.username || '?').charAt(0).toUpperCase();
  const displayName = quoted.display_name || quoted.username || '';
  const username = quoted.username ? `@${quoted.username}` : '';
  const titleBadge = createUserTitleBadge(quoted);

  // The body keeps its own renderer (post colours or plain text), so the
  // template only reserves the node and the text lands after mount.
  const bodyText = stripMediaCues(quoted.text || '').replace(/\\\{/g, '{');
  const coloredBody = canUsePostColors({ badge_type: quoted.badge_type })
    ? parsePostColors(stripMediaCues(quoted.text || ''))
    : null;

  const attachment = createQuotedPostAttachment(quoted);

  let avatar!: HTMLElement;
  let name!: HTMLElement;
  let body!: HTMLElement;

  // One line for the author row (inline elements), then the block children.
  mount(
    card,
    () =>
      html`<div class="quoted-post-author"><span class="quoted-post-avatar" ref=${(element: Element | null) => {
        if (element) avatar = element as HTMLElement;
      }}>${avatarInitial}</span><span class="quoted-post-name" ref=${(element: Element | null) => {
        if (element) name = element as HTMLElement;
      }}>${displayName}</span><span class="quoted-post-username">${username}</span>${titleBadge ?? ''}</div><div class="quoted-post-text" ref=${(
        element: Element | null,
      ) => {
        if (element) body = element as HTMLElement;
      }}></div>${attachment ?? ''}`,
  );

  if (avatarImage) {
    avatar.style.backgroundImage = `url(${avatarImage})`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
  }
  attachPlusBadge(avatar, quoted.badge_type);
  applyNameColor(name, quoted.name_color, quoted.badge_type);

  if (coloredBody) body.appendChild(renderColorizedText(coloredBody.plain, coloredBody.spans));
  else body.textContent = bodyText;

  return card;
}
