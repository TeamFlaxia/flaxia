import { t } from '../lib/i18n.js';
import { nativeApiHref } from '../lib/native-api.js';
import { setOfflineImage } from '../lib/offline-image.js';
import { parseMediaCues } from '../lib/post-cues.js';
import { isDataSaverEnabled } from '../lib/settings.js';
import { executeZipAuto, type UniversalZipExecutorHandle } from '../lib/zip-manager.js';
import { PostCardMode, PostStageProps } from '../types/post.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { executeFlash, type FlashPlayerHandle } from './FlashPlayer.js';
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
  // Data-saver: skip thumbnail bytes for ZIP/SWF — the play overlay already
  // requires a tap, so the poster is pure prefetch cost.
  const skipThumbnail = isDataSaverEnabled();
  if (skipThumbnail) {
    image.style.display = 'none';
    imageContainer.dataset.dataSaver = '1';
    imageContainer.style.background = 'var(--bg-input)';
  } else {
    setOfflineImage(image, nativeApiHref(`/api/thumbnail/${props.postId}`));
    // Timeline mounts dozens of stages: decode lazily so off-screen
    // thumbnails don't contend with first paint.
    image.loading = 'lazy';
    image.decoding = 'async';
  }

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

interface StageState {
  postId: string;
  mode: PostCardMode;
  preview: HTMLElement | null;
  previewSignature: string | null;
  execution: HTMLElement | null;
  executionVersion: string | null;
  executionToken: number;
  executionReady: boolean;
  zipHandle?: UniversalZipExecutorHandle;
  flashHandle?: FlashPlayerHandle;
  disposed: boolean;
}

const STAGE_CLASSES = [
  'post-stage--carousel',
  'post-stage--zip',
  'post-stage--flash',
  'post-stage--audio',
  'post-stage--video',
  'post-stage--image',
  'post-stage--image-thumb',
] as const;

const stageStates = new WeakMap<HTMLElement, StageState>();

function stageState(container: HTMLElement, props: PostStageProps): StageState {
  let state = stageStates.get(container);
  if (!state) {
    state = {
      postId: props.post.id,
      mode: props.mode,
      preview: null,
      previewSignature: null,
      execution: null,
      executionVersion: null,
      executionToken: 0,
      executionReady: false,
      disposed: false,
    };
    stageStates.set(container, state);
  }
  return state;
}

function mediaSignature(post: PostStageProps['post']): string {
  const attachments = (post.attachments ?? []).map((attachment) => `${attachment.kind}:${attachment.r2_key}`).join(',');
  return [post.gif_key ?? '', post.payload_key ?? '', post.swf_key ?? '', post.thumbnail_key ?? '', attachments].join(
    '|',
  );
}

function stageClassFor(post: PostStageProps['post']): string | null {
  if ((post.attachments ?? []).length > 0) return 'post-stage--carousel';
  if (isZipGame(post.payload_key)) return 'post-stage--zip';
  if (post.swf_key?.startsWith('swf/')) return 'post-stage--flash';
  if (post.gif_key?.startsWith('audio/')) return 'post-stage--audio';
  if (post.gif_key?.startsWith('video/')) return 'post-stage--video';
  if (post.gif_key) return 'post-stage--image';
  if (post.thumbnail_key) return 'post-stage--image-thumb';
  return null;
}

function setStageClass(container: HTMLElement, className: string | null): void {
  container.classList.remove(...STAGE_CLASSES);
  if (className) container.classList.add(className);
}

function buildPreviewMedia(props: PostStageProps): HTMLElement | null {
  const post = props.post;
  const attachments = post.attachments ?? [];
  const cues = parseMediaCues(post.text).cues;
  const cueList = cues.length > 0 ? cues : undefined;

  if (attachments.length > 0) {
    return createMediaCarousel({ postId: post.id, attachments, cues: cueList });
  }

  if (isZipGame(post.payload_key)) {
    if (post.thumbnail_key) {
      return createThumbnailWithOverlay({
        postId: post.id,
        thumbnailKey: post.thumbnail_key,
        overlayLabel: t('post_stage.run_zip'),
        aspectRatio: '56.25',
        onClick: () => props.onModeChange(PostCardMode.EXECUTING),
      });
    }
    return createExecutionButton({
      postId: post.id,
      label: t('post_stage.click_execute_zip'),
      icon: '▶',
      onClick: () => props.onModeChange(PostCardMode.EXECUTING),
    });
  }

  if (post.swf_key?.startsWith('swf/')) {
    if (post.thumbnail_key) {
      return createThumbnailWithOverlay({
        postId: post.id,
        thumbnailKey: post.thumbnail_key,
        overlayLabel: t('post_stage.play_flash'),
        aspectRatio: '75',
        onClick: () => props.onModeChange(PostCardMode.EXECUTING),
      });
    }
    return createSwfExecutionButton({
      postId: post.id,
      label: t('post_stage.click_play_flash'),
      icon: '▶',
      onClick: () => props.onModeChange(PostCardMode.EXECUTING),
    });
  }

  if (post.gif_key?.startsWith('audio/')) {
    return createAudioPlayer({ gifKey: post.gif_key, postId: post.id, cues: cueList });
  }
  if (post.gif_key?.startsWith('video/')) {
    return createVideoPlayer({ gifKey: post.gif_key, postId: post.id, cues: cueList });
  }
  if (post.gif_key) {
    return createImagePreview({ gifKey: post.gif_key, postId: post.id, ratio: '16:9' });
  }
  if (post.thumbnail_key) {
    return createImagePreview({ gifKey: post.thumbnail_key, postId: post.id, isThumbnail: true, ratio: '16:9' });
  }
  return null;
}

function showPreview(container: HTMLElement, state: StageState, props: PostStageProps): void {
  const signature = mediaSignature(props.post);
  if (state.preview && state.previewSignature === signature) {
    state.preview.hidden = false;
    return;
  }

  state.preview?.remove();
  const layer = document.createElement('div');
  layer.className = 'post-stage-layer post-stage-layer--preview';

  const media = buildPreviewMedia(props);
  if (media) layer.appendChild(media);

  const post = props.post;
  const attachments = post.attachments ?? [];
  if (attachments.length === 0 && !isZipGame(post.payload_key) && !post.swf_key?.startsWith('swf/') && !post.gif_key) {
    const hint = document.createElement('div');
    hint.className = 'stage-hint';
    hint.textContent = t('post_stage.click_to_run');
    layer.appendChild(hint);
  }

  state.preview = layer;
  state.previewSignature = signature;
  container.appendChild(layer);
}

async function showExecution(container: HTMLElement, state: StageState, props: PostStageProps): Promise<void> {
  const version = props.versionId ?? null;

  if (state.execution && state.executionVersion === version && state.executionReady) {
    // A different card may have taken the global executor slot and destroyed
    // this iframe. Rebuild only when the DOM is actually gone.
    if (state.execution.querySelector('iframe')) {
      state.execution.hidden = false;
      return;
    }
  }

  // Invalidate any in-flight execution before replacing the layer.
  state.executionToken++;
  state.zipHandle?.destroy();
  state.zipHandle = undefined;
  state.flashHandle?.destroy();
  state.flashHandle = undefined;
  state.execution?.remove();

  const execution = document.createElement('div');
  execution.className = 'post-stage-layer post-stage-layer--execution';
  state.execution = execution;
  state.executionVersion = version;
  state.executionReady = false;
  container.appendChild(execution);

  const token = state.executionToken;

  try {
    if (isZipGame(props.post.payload_key)) {
      const handle = await executeZipAuto(props.post.id, execution, undefined, version ?? undefined);
      if (state.disposed || token !== state.executionToken) {
        handle.destroy();
        return;
      }
      state.zipHandle = handle;
    } else if (props.post.swf_key?.startsWith('swf/')) {
      const handle = await executeFlash(props.post.id, execution);
      if (state.disposed || token !== state.executionToken) {
        handle.destroy();
        return;
      }
      state.flashHandle = handle;
    } else {
      const { createSandboxFrame } = await import('./SandboxFrame.js');
      if (state.disposed || token !== state.executionToken) return;
      execution.appendChild(
        createSandboxFrame({
          postId: props.post.id,
          sandboxOrigin: props.sandboxOrigin,
          versionId: props.versionId,
        }),
      );
    }

    if (state.disposed || token !== state.executionToken) return;
    state.executionReady = true;
    execution.hidden = state.mode !== PostCardMode.EXECUTING;
  } catch (error) {
    if (state.disposed || token !== state.executionToken) return;
    console.error('Failed to execute post content:', error);
    execution.replaceChildren();
    const message = document.createElement('div');
    message.className = 'stage-error';
    message.textContent = isZipGame(props.post.payload_key)
      ? t('post_stage.zip_load_error')
      : props.post.swf_key
        ? t('post_stage.flash_load_error')
        : t('common.error');
    execution.appendChild(message);
    state.executionReady = true;
    execution.hidden = state.mode !== PostCardMode.EXECUTING;
  }
}

function disposeLayers(state: StageState): void {
  state.executionToken++;
  state.zipHandle?.destroy();
  state.zipHandle = undefined;
  state.flashHandle?.destroy();
  state.flashHandle = undefined;
  state.execution?.remove();
  state.execution = null;
  state.executionReady = false;
  state.preview?.remove();
  state.preview = null;
  state.previewSignature = null;
}

/** Release a stage's timers, iframe handles and layers. */
export function destroyPostStage(container: HTMLElement): void {
  const state = stageStates.get(container);
  if (!state) return;
  state.disposed = true;
  disposeLayers(state);
  stageStates.delete(container);
}

export function createPostStage(props: PostStageProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'post-stage';
  const state = stageState(container, props);

  // Click toggles the stage. Use the state's current mode instead of the mode
  // captured at creation, so the second click returns to the preview.
  container.addEventListener('click', (e) => {
    if (props.post.attachments?.length) return;
    // Only posts with executable content have a second mode.
    if (!props.post.payload_key && !props.post.swf_key) return;

    if ((e.target as HTMLElement).closest('.zip-execution-button')) {
      return;
    }

    if ((e.target as HTMLElement).closest('.video-player, .audio-player, .image-preview')) {
      return;
    }

    if (isZipGame(props.post.payload_key)) {
      e.stopPropagation();
    }

    props.onModeChange(state.mode === PostCardMode.PREVIEW ? PostCardMode.EXECUTING : PostCardMode.PREVIEW);
  });

  updateStageContent(container, props).catch((error) => {
    console.error('Error updating stage content:', error);
  });

  return container;
}

async function updateStageContent(container: HTMLElement, props: PostStageProps): Promise<void> {
  const state = stageState(container, props);
  if (state.disposed) return;

  state.mode = props.mode;
  state.postId = props.post.id;

  const attachments = props.post.attachments ?? [];
  const hasMedia = Boolean(
    attachments.length > 0 ||
      props.post.gif_key ||
      props.post.payload_key ||
      props.post.swf_key ||
      props.post.thumbnail_key,
  );

  setStageClass(container, stageClassFor(props.post));

  // ZIP and SWF stages reserve their aspect ratio with fx-box instead of the
  // legacy padding-bottom trick. Other media keep their existing sizing.
  const boxRatio = isZipGame(props.post.payload_key)
    ? '16 / 9'
    : props.post.swf_key?.startsWith('swf/')
      ? '4 / 3'
      : null;
  container.classList.toggle('fx-box', boxRatio !== null);
  if (boxRatio) container.style.setProperty('--fx-ratio', boxRatio);
  else container.style.removeProperty('--fx-ratio');

  if (!hasMedia) {
    disposeLayers(state);
    return;
  }

  // Attachments and non-executable media never have an execution mode.
  const canExecute = attachments.length === 0 && Boolean(props.post.payload_key || props.post.swf_key);

  if (!canExecute || props.mode === PostCardMode.PREVIEW) {
    if (state.execution) state.execution.hidden = true;
    showPreview(container, state, props);
    return;
  }

  if (state.preview) state.preview.hidden = true;
  await showExecution(container, state, props);
}

// Export a function to update the stage content when mode changes
export function updatePostStage(container: HTMLElement, props: PostStageProps): void {
  updateStageContent(container, props).catch((error) => {
    console.error('Error updating stage content:', error);
  });
}
