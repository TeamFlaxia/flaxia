// Adapters around legacy media factories used by the Svelte quoted-post card.
import { parseMediaCues } from '../../../shared/post-cues.ts';
import type { QuotedPost } from '../../../shared/types/post.ts';
import { createAudioPlayer } from '../../components/AudioPlayer.js';
import { createImagePreview } from '../../components/ImagePreview.js';
import { createMediaCarousel } from '../../components/MediaCarousel.js';
import { isZipGame, stripLeadingEmoji } from '../../components/PostStage.js';
import { createVideoPlayer } from '../../components/VideoPlayer.js';
import { t } from '../i18n.ts';

export function mountQuotedAttachment(host: HTMLElement, quoted: QuotedPost): void {
  const hasMedia = Boolean(
    quoted.gif_key ||
      quoted.payload_key ||
      quoted.swf_key ||
      quoted.thumbnail_key ||
      (quoted.attachments && quoted.attachments.length > 0),
  );
  if (!hasMedia) return;
  const wrap = document.createElement('div');
  wrap.className = 'quoted-post-attachment';
  const cues = parseMediaCues(quoted.text || '').cues;

  if (quoted.attachments && quoted.attachments.length > 0) {
    wrap.appendChild(createMediaCarousel({ postId: quoted.id, attachments: quoted.attachments, cues }));
    host.replaceChildren(wrap);
    return;
  }

  const gifKey = quoted.gif_key || '';
  if (gifKey.startsWith('video/')) wrap.appendChild(createVideoPlayer({ gifKey, postId: quoted.id, cues }));
  else if (gifKey.startsWith('audio/')) wrap.appendChild(createAudioPlayer({ gifKey, postId: quoted.id, cues }));
  else if (gifKey) wrap.appendChild(createImagePreview({ gifKey, postId: quoted.id, ratio: '16:9' }));
  else {
    const executable = isZipGame(quoted.payload_key) || (!!quoted.swf_key && quoted.swf_key.startsWith('swf/'));
    if (quoted.thumbnail_key) {
      wrap.appendChild(
        createImagePreview({ gifKey: quoted.thumbnail_key, postId: quoted.id, isThumbnail: true, ratio: '16:9' }),
      );
      if (executable) {
        const badge = document.createElement('div');
        badge.className = 'quoted-post-attachment-badge';
        badge.textContent = quoted.swf_key?.startsWith('swf/')
          ? stripLeadingEmoji(t('post_stage.play_flash'))
          : stripLeadingEmoji(t('post_stage.run_zip'));
        wrap.appendChild(badge);
      }
    } else if (executable) {
      const pill = document.createElement('div');
      pill.className = 'quoted-post-attachment-pill';
      pill.textContent = quoted.swf_key?.startsWith('swf/')
        ? stripLeadingEmoji(t('post_stage.click_play_flash'))
        : stripLeadingEmoji(t('post_stage.click_to_run'));
      wrap.appendChild(pill);
    } else {
      return;
    }
  }
  host.replaceChildren(wrap);
}
