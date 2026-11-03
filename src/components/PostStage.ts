import { t } from '../lib/i18n.js';
import { nativeApiHref } from '../lib/native-api.js';
import { setOfflineImage } from '../lib/offline-image.js';
import { executeZipAuto } from '../lib/zip-manager.js';
import { PostCardMode, PostStageProps } from '../types/post.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { executeFlash } from './FlashPlayer.js';
import { createImagePreview } from './ImagePreview.js';
import { createMediaCarousel } from './MediaCarousel.js';
import { createVideoPlayer } from './VideoPlayer.js';

// Strip a leading emoji from a translated label so the play overlay can
// pair its own typographic glyph with plain text.
export function stripLeadingEmoji(label: string): string {
  return label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '');
}

// Keyboard parity for the div-based launch surfaces.
function makeActivatable(element: HTMLElement): void {
  element.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    element.click();
  });
}

// Create SWF execution button (similar to ZIP but for Flash)
function createSwfExecutionButton(props: {
  postId: string;
  label: string;
  icon: string;
  onClick: () => void;
}): HTMLElement {
  const container = document.createElement('div');
  container.className = 'execution-button';
  container.setAttribute('role', 'button');
  container.setAttribute('tabindex', '0');
  container.setAttribute('aria-label', props.label);

  // Icon
  const icon = document.createElement('span');
  icon.className = 'stage-launch-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = props.icon;

  // Text
  const text = document.createElement('span');
  text.className = 'stage-launch-label';
  text.textContent = stripLeadingEmoji(props.label);

  container.appendChild(icon);
  container.appendChild(text);
  makeActivatable(container);

  // Click handler - directly trigger mode change for SWF
  container.addEventListener('click', async (e) => {
    e.stopPropagation();

    // Show loading state
    const originalContent = container.innerHTML;
    container.innerHTML = stripLeadingEmoji(t('post_stage.loading_flash'));
    container.style.pointerEvents = 'none';

    try {
      // For SWF, just trigger the mode change to show Flash player
      props.onClick();
    } catch (error) {
      console.error('Failed to load SWF:', error);
      container.innerHTML = originalContent;
      container.style.pointerEvents = 'auto';
      alert(t('post_stage.load_failed_flash'));
    }
  });

  return container;
}

interface ZipExecutionButtonProps {
  postId: string;
  label: string;
  icon: string;
  onClick: () => void;
}

function createExecutionButton(props: ZipExecutionButtonProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'zip-execution-button';
  container.setAttribute('role', 'button');
  container.setAttribute('tabindex', '0');
  container.setAttribute('aria-label', props.label);

  const icon = document.createElement('span');
  icon.className = 'stage-launch-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = props.icon;

  const text = document.createElement('span');
  text.className = 'stage-launch-label';
  text.textContent = stripLeadingEmoji(props.label);

  container.appendChild(icon);
  container.appendChild(text);
  makeActivatable(container);

  // Click handler
  container.addEventListener('click', (e) => {
    e.stopPropagation();
    props.onClick();
  });

  return container;
}

// Create thumbnail with overlay button for ZIP/SWF posts
function createThumbnailWithOverlay(props: {
  postId: string;
  thumbnailKey: string;
  overlayLabel: string;
  aspectRatio?: string;
  onClick: () => void;
}): HTMLElement {
  const container = document.createElement('div');
  container.className = 'thumbnail-overlay-container';
  container.setAttribute('role', 'button');
  container.setAttribute('tabindex', '0');
  container.setAttribute('aria-label', stripLeadingEmoji(props.overlayLabel));

  // The parent .post-stage--flash/--zip already establishes the aspect ratio
  // via padding-bottom, so we use absolute positioning to fill it instead of
  // adding another padding-bottom (which would double the height).
  // Image container
  const imageContainer = document.createElement('div');
  imageContainer.className = 'thumbnail-media';

  // Thumbnail image
  const image = document.createElement('img');
  setOfflineImage(image, nativeApiHref(`/api/thumbnail/${props.postId}`));
  // Timeline mounts dozens of stages: decode lazily so off-screen
  // thumbnails don't contend with first paint.
  image.loading = 'lazy';
  image.decoding = 'async';

  // Load image with fade-in (CSS owns the opacity transition)
  image.onload = () => {
    image.classList.add('is-loaded');
  };

  image.onerror = () => {
    // Show fallback on error
    image.style.display = 'none';
    const fallback = document.createElement('div');
    fallback.className = 'stage-fallback';
    fallback.textContent = t('post_stage.thumbnail_unavailable');
    imageContainer.appendChild(fallback);
  };

  // Play affordance: icon disc + label (hover handled in CSS).
  const overlay = document.createElement('div');
  overlay.className = 'stage-play-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  const playIcon = document.createElement('span');
  playIcon.className = 'stage-play-icon';
  playIcon.textContent = '▶';

  const playLabel = document.createElement('span');
  playLabel.className = 'stage-play-label';
  playLabel.textContent = stripLeadingEmoji(props.overlayLabel);

  overlay.appendChild(playIcon);
  overlay.appendChild(playLabel);

  imageContainer.appendChild(image);
  imageContainer.appendChild(overlay);
  container.appendChild(imageContainer);
  makeActivatable(container);

  // Click handler - trigger execution
  container.addEventListener('click', (e) => {
    e.stopPropagation();
    props.onClick();
  });

  return container;
}

// A post is a runnable ZIP/HTML5 game when its payload key lives under one of
// the known game prefixes (payload/, zip/, html/, versions/). The latter is set
// once a game has been published as a new version via the rolling-update flow.
export function isZipGame(payloadKey?: string | null): boolean {
  if (!payloadKey) return false;
  return (
    payloadKey.endsWith('.zip') ||
    payloadKey.endsWith('.html') ||
    payloadKey.startsWith('zip/') ||
    payloadKey.startsWith('html/') ||
    payloadKey.startsWith('payload/') ||
    payloadKey.startsWith('versions/')
  );
}

export function createPostStage(props: PostStageProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'post-stage';

  // Click handler to toggle between preview and execution modes
  // Only for post types that have execution modes (ZIP/SWF)
  container.addEventListener('click', (e) => {
    // Media-only posts have no execution mode — never toggle away from them
    if (props.post.attachments?.length) {
      return;
    }

    // Don't toggle mode if clicking on execution button (ZIP or SWF)
    if ((e.target as HTMLElement).closest('.zip-execution-button')) {
      return;
    }

    // Don't toggle mode for media players (image, audio, video)
    if ((e.target as HTMLElement).closest('.video-player, .audio-player, .image-preview')) {
      return;
    }

    // ZIP games launch in Arcade from the mode-change handler; keep the click
    // from bubbling to PostCard's thread navigation as well.
    if (isZipGame(props.post.payload_key)) {
      e.stopPropagation();
    }

    const newMode = props.mode === PostCardMode.PREVIEW ? PostCardMode.EXECUTING : PostCardMode.PREVIEW;
    props.onModeChange(newMode);
  });

  // Render current mode
  updateStageContent(container, props).catch((error) => {
    console.error('Error updating stage content:', error);
  });

  return container;
}

async function updateStageContent(container: HTMLElement, props: PostStageProps): Promise<void> {
  // Clear existing content
  container.innerHTML = '';

  const attachments = props.post.attachments || [];

  // Only show content if there are attachments or a thumbnail
  if (
    attachments.length === 0 &&
    !props.post.gif_key &&
    !props.post.payload_key &&
    !props.post.swf_key &&
    !props.post.thumbnail_key
  ) {
    return;
  }

  if (props.mode === PostCardMode.PREVIEW) {
    let mediaElement: HTMLElement = null!;

    if (attachments.length > 0) {
      // Multi-media attachments render as a horizontal scroll carousel
      container.classList.add('post-stage--carousel');
      mediaElement = createMediaCarousel({ postId: props.post.id, attachments });
      container.appendChild(mediaElement);
      return;
    }

    if (isZipGame(props.post.payload_key)) {
      container.classList.add('post-stage--zip'); // Add zip class for 16:9
      if (props.post.thumbnail_key) {
        // Show thumbnail with overlay button
        mediaElement = createThumbnailWithOverlay({
          postId: props.post.id,
          thumbnailKey: props.post.thumbnail_key,
          overlayLabel: t('post_stage.run_zip'),
          aspectRatio: '56.25', // 16:9
          onClick: () => props.onModeChange(PostCardMode.EXECUTING),
        });
      } else {
        // Create ZIP execution button (existing behavior)
        mediaElement = createExecutionButton({
          postId: props.post.id,
          label: t('post_stage.click_execute_zip'),
          icon: '▶',
          onClick: () => props.onModeChange(PostCardMode.EXECUTING),
        });
      }
    } else if (props.post.swf_key && props.post.swf_key.startsWith('swf/')) {
      if (props.post.thumbnail_key) {
        // Show thumbnail with overlay button
        mediaElement = createThumbnailWithOverlay({
          postId: props.post.id,
          thumbnailKey: props.post.thumbnail_key,
          overlayLabel: t('post_stage.play_flash'),
          aspectRatio: '75', // 4:3 = 75%
          onClick: () => props.onModeChange(PostCardMode.EXECUTING),
        });
        // Add flash class for 4:3 aspect ratio
        container.classList.add('post-stage--flash');
      } else {
        // Create SWF execution button (existing behavior)
        mediaElement = createSwfExecutionButton({
          postId: props.post.id,
          label: t('post_stage.click_play_flash'),
          icon: '▶',
          onClick: () => props.onModeChange(PostCardMode.EXECUTING),
        });
        // Add flash class for 4:3 aspect ratio
        container.classList.add('post-stage--flash');
      }
    } else if (props.post.gif_key && props.post.gif_key.startsWith('audio/')) {
      container.classList.add('post-stage--audio');
      mediaElement = createAudioPlayer({
        gifKey: props.post.gif_key,
        postId: props.post.id,
      });
    } else if (props.post.gif_key && props.post.gif_key.startsWith('video/')) {
      container.classList.add('post-stage--video');
      mediaElement = createVideoPlayer({
        gifKey: props.post.gif_key,
        postId: props.post.id,
      });
    } else if (props.post.gif_key) {
      container.classList.add('post-stage--image');
      mediaElement = createImagePreview({
        gifKey: props.post.gif_key,
        postId: props.post.id,
        ratio: '16:9',
      });
    } else if (props.post.thumbnail_key) {
      // Post has only thumbnail
      container.classList.add('post-stage--image-thumb');
      mediaElement = createImagePreview({
        gifKey: props.post.thumbnail_key, // createImagePreview handles both gif and thumbnail keys
        postId: props.post.id,
        isThumbnail: true,
        ratio: '16:9',
      });
    }

    container.appendChild(mediaElement);

    // Add click hint only for executable content (not images or audio)
    if (!isZipGame(props.post.payload_key) && !props.post.swf_key?.startsWith('swf/') && !props.post.gif_key) {
      const hint = document.createElement('div');
      hint.className = 'stage-hint';
      hint.textContent = t('post_stage.click_to_run');
      container.appendChild(hint);
    }
  } else {
    if (attachments.length > 0) {
      // Attachments have no execution mode — keep showing the carousel even if
      // the stage somehow ended up in EXECUTING mode.
      container.classList.add('post-stage--carousel');
      container.appendChild(createMediaCarousel({ postId: props.post.id, attachments }));
    } else if (isZipGame(props.post.payload_key)) {
      // The executeZipAuto function will handle creating the iframe and cleanup
      executeZipAuto(props.post.id, container, undefined, props.versionId).catch((error: Error) => {
        console.error('Failed to execute ZIP:', error);
        container.innerHTML =
          '<div style="padding: 20px; text-align: center; color: var(--text-muted);">' +
          t('post_stage.zip_load_error') +
          '</div>';
      });
    } else if (props.post.swf_key && props.post.swf_key.startsWith('swf/')) {
      // Execute Flash/SWF content using Ruffle
      executeFlash(props.post.id, container).catch((error) => {
        console.error('Failed to execute SWF:', error);
        container.innerHTML =
          '<div style="padding: 20px; text-align: center; color: var(--text-muted);">' +
          t('post_stage.flash_load_error') +
          '</div>';
      });
    } else {
      // For non-ZIP files, use the old sandbox frame
      const { createSandboxFrame } = await import('./SandboxFrame.js');
      const sandboxFrame = createSandboxFrame({
        postId: props.post.id,
        sandboxOrigin: props.sandboxOrigin,
        versionId: props.versionId,
      });
      container.appendChild(sandboxFrame);
    }
  }
}

// Export a function to update the stage content when mode changes
export function updatePostStage(container: HTMLElement, props: PostStageProps): void {
  updateStageContent(container, props).catch((error) => {
    console.error('Error updating stage content:', error);
  });
}
