import { t } from '../lib/i18n.js';
import { executeZipAuto } from '../lib/zip-manager.js';
import { PostCardMode, PostStageProps } from '../types/post.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { executeFlash } from './FlashPlayer.js';
import { createImagePreview } from './ImagePreview.js';
import { createMediaCarousel } from './MediaCarousel.js';
import { createVideoPlayer } from './VideoPlayer.js';

// Create SWF execution button (similar to ZIP but for Flash)
function createSwfExecutionButton(props: {
  postId: string;
  label: string;
  icon: string;
  onClick: () => void;
}): HTMLElement {
  const container = document.createElement('div');
  container.className = 'execution-button';
  container.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    cursor: pointer;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border-radius: 8px;
    transition: all 0.2s ease;
    padding: 20px;
  `;

  // Icon
  const icon = document.createElement('div');
  icon.textContent = props.icon;
  icon.style.cssText = `
    font-size: 48px;
    margin-bottom: 12px;
  `;

  // Text
  const text = document.createElement('div');
  text.textContent = props.label;
  text.style.cssText = `
    font-size: 16px;
    font-weight: 600;
    text-align: center;
  `;

  container.appendChild(icon);
  container.appendChild(text);

  // Hover effects
  container.addEventListener('mouseenter', () => {
    container.style.transform = 'scale(1.02)';
    container.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)';
  });

  container.addEventListener('mouseleave', () => {
    container.style.transform = 'scale(1)';
    container.style.boxShadow = 'none';
  });

  // Click handler - directly trigger mode change for SWF
  container.addEventListener('click', async (e) => {
    e.stopPropagation();

    // Show loading state
    const originalContent = container.innerHTML;
    container.innerHTML = t('post_stage.loading_flash');
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
  container.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: white;
    font-weight: 600;
    font-size: 16px;
    gap: 8px;
  `;

  const icon = document.createElement('span');
  icon.textContent = props.icon;
  icon.style.fontSize = '24px';

  const text = document.createElement('span');
  text.textContent = props.label;

  container.appendChild(icon);
  container.appendChild(text);

  // Hover effects
  container.addEventListener('mouseenter', () => {
    container.style.transform = 'scale(1.02)';
    container.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)';
  });

  container.addEventListener('mouseleave', () => {
    container.style.transform = 'scale(1)';
    container.style.boxShadow = 'none';
  });

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

  // The parent .post-stage--flash/--zip already establishes the aspect ratio
  // via padding-bottom, so we use absolute positioning to fill it instead of
  // adding another padding-bottom (which would double the height).
  container.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: var(--bg-input);
    border-radius: 8px;
    overflow: hidden;
  `;

  // Image container
  const imageContainer = document.createElement('div');
  imageContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  `;

  // Thumbnail image
  const image = document.createElement('img');
  image.src = `/api/thumbnail/${props.postId}`;
  image.style.cssText = `
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 0;
    transition: opacity 0.3s ease;
    image-rendering: auto;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    backface-visibility: hidden;
    transform: translateZ(0);
    filter: contrast(1.1) brightness(1.05);
  `;

  // Load image with fade-in
  image.onload = () => {
    image.style.opacity = '1';
  };

  image.onerror = () => {
    // Show fallback on error
    image.style.display = 'none';
    const fallback = document.createElement('div');
    fallback.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-secondary);
      color: var(--text-muted);
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 0.875rem;
    `;
    fallback.textContent = t('post_stage.thumbnail_unavailable');
    imageContainer.appendChild(fallback);
  };

  // Overlay button
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.7);
    color: white;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s ease;
    pointer-events: none;
    z-index: 2;
  `;
  overlay.textContent = props.overlayLabel;

  imageContainer.appendChild(image);
  imageContainer.appendChild(overlay);
  container.appendChild(imageContainer);

  // Hover effects
  container.addEventListener('mouseenter', () => {
    overlay.style.background = 'rgba(0, 0, 0, 0.8)';
    overlay.style.transform = 'translate(-50%, -50%) scale(1.05)';
  });

  container.addEventListener('mouseleave', () => {
    overlay.style.background = 'rgba(0, 0, 0, 0.7)';
    overlay.style.transform = 'translate(-50%, -50%) scale(1)';
  });

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
          icon: '🚀',
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
          icon: '⚡',
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
      });
    } else if (props.post.thumbnail_key) {
      // Post has only thumbnail
      container.classList.add('post-stage--image-thumb');
      mediaElement = createImagePreview({
        gifKey: props.post.thumbnail_key, // createImagePreview handles both gif and thumbnail keys
        postId: props.post.id,
        isThumbnail: true,
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
