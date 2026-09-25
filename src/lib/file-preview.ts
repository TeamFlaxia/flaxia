import { createAudioPlayer } from '../components/AudioPlayer.js';
import { executeFlash } from '../components/FlashPlayer.js';
import { createVideoPlayer } from '../components/VideoPlayer.js';
import { t } from './i18n.js';

export type AttachPreviewKind = 'image' | 'audio' | 'video' | 'game' | 'document';

export interface AttachPreviewHandle {
  destroy: () => void;
}

// Mirrors the server-side caps in functions/lib/image-dimensions.ts. Browsers
// rasterize images at native resolution, so decoding a huge image (or an
// oversized animated GIF) in the composer or timeline can crash the tab.
const MAX_IMAGE_DIMENSION = 6000;
const MAX_IMAGE_PIXELS = 24 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['gif', 'png', 'jpg', 'jpeg']);

// Decodes the image once to check its native dimensions, then revokes the
// object URL. Returns an error message when the image exceeds the caps,
// otherwise null. Unparseable files pass through (the server will reject them).
export function checkImageSizeLimit(file: File): Promise<string | null> {
  const ext = file.name.toLowerCase().split('.').pop() || '';
  if (!IMAGE_EXTENSIONS.has(ext)) return Promise.resolve(null);

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { naturalWidth: w, naturalHeight: h } = img;
      if (w > MAX_IMAGE_DIMENSION || h > MAX_IMAGE_DIMENSION || w * h > MAX_IMAGE_PIXELS) {
        resolve(t('composer.error_image_too_large'));
      } else {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export function detectAttachKind(file: File): AttachPreviewKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.gif') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image';
  }
  if (name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.ogg') || name.endsWith('.m4a')) {
    return 'audio';
  }
  if (name.endsWith('.webm') || name.endsWith('.mp4') || name.endsWith('.mov')) {
    return 'video';
  }
  if (name.endsWith('.zip') || name.endsWith('.swf')) {
    return 'game';
  }
  if (name.endsWith('.pdf')) {
    return 'document';
  }
  return null;
}

/**
 * Renders an inline preview of a selected attachment inside the composer's
 * file preview area. Images, audio and video are shown as compact inline
 * media; games (.zip / .swf) render as a chip with a play button that executes
 * the game once clicked; documents (.pdf) render as a chip with an open button.
 */
export function renderFilePreview(file: File, previewContainer: HTMLElement): AttachPreviewHandle {
  const kind = detectAttachKind(file);

  const body = document.createElement('div');
  body.className = 'file-preview-body';

  const revokeUrls: Array<() => void> = [];
  let gameHandle: { destroy: () => void } | null = null;

  if (kind === 'image') {
    const url = URL.createObjectURL(file);
    revokeUrls.push(() => URL.revokeObjectURL(url));
    const img = document.createElement('img');
    img.className = 'file-preview-image';
    img.src = url;
    img.alt = file.name;
    body.appendChild(img);
  } else if (kind === 'audio') {
    const url = URL.createObjectURL(file);
    revokeUrls.push(() => URL.revokeObjectURL(url));
    const wrap = document.createElement('div');
    wrap.className = 'file-preview-media file-preview-media--audio';
    const player = createAudioPlayer({ gifKey: '', postId: 'preview', src: url });
    wrap.appendChild(player);
    body.appendChild(wrap);
  } else if (kind === 'video') {
    const url = URL.createObjectURL(file);
    revokeUrls.push(() => URL.revokeObjectURL(url));
    const wrap = document.createElement('div');
    wrap.className = 'file-preview-media file-preview-media--video';
    const player = createVideoPlayer({ gifKey: '', postId: 'preview', src: url });
    wrap.appendChild(player);
    body.appendChild(wrap);
  } else if (kind === 'game') {
    const gameStage = document.createElement('div');
    gameStage.className = 'file-preview-game-stage';
    gameStage.style.display = 'none';
    const ext = file.name.toLowerCase().split('.').pop() || '';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'file-preview-game-play';
    playBtn.textContent = t('composer.preview_play');

    playBtn.addEventListener('click', () => {
      playBtn.disabled = true;
      playBtn.textContent = t('composer.preview_playing');
      gameStage.style.display = 'block';
      if (ext === 'swf') {
        void (async () => {
          try {
            const data = await file.arrayBuffer();
            gameHandle = await executeFlash('preview', gameStage, undefined, true, data);
          } catch (error) {
            console.error('Failed to preview SWF:', error);
            showGameError(gameStage, error);
          }
        })();
        return;
      }
      void runGame(file, gameStage, (h) => (gameHandle = h));
    });

    const chipIcon = document.createElement('span');
    chipIcon.className = 'file-preview-game-icon';
    chipIcon.textContent = ext === 'swf' ? '⚡' : '🕹️';

    const chip = document.createElement('div');
    chip.className = 'file-preview-game-chip';
    chip.appendChild(chipIcon);
    chip.appendChild(playBtn);

    body.appendChild(chip);
    body.appendChild(gameStage);
  } else if (kind === 'document') {
    // Documents are not rasterised in the composer: a chip with an explicit
    // open action keeps the preview cheap and avoids a nested PDF plugin
    // while the post is still being written.
    const url = URL.createObjectURL(file);
    revokeUrls.push(() => URL.revokeObjectURL(url));

    const chip = document.createElement('div');
    chip.className = 'file-preview-doc-chip';

    const icon = document.createElement('span');
    icon.className = 'file-preview-doc-icon';
    icon.textContent = '📄';

    const label = document.createElement('span');
    label.className = 'file-preview-doc-label';
    label.textContent = `${file.name} (${formatPreviewSize(file.size)})`;

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'file-preview-doc-open';
    openBtn.textContent = t('composer.preview_open_document');
    openBtn.addEventListener('click', () => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });

    chip.appendChild(icon);
    chip.appendChild(label);
    chip.appendChild(openBtn);
    body.appendChild(chip);
  } else {
    const text = document.createElement('div');
    text.className = 'file-preview-plain';
    text.textContent = `${file.name} (${formatPreviewSize(file.size)})`;
    body.appendChild(text);
  }

  previewContainer.appendChild(body);

  return {
    destroy: () => {
      for (const fn of revokeUrls) fn();
      if (gameHandle) {
        try {
          gameHandle.destroy();
        } catch {
          /* ignore */
        }
      }
      body.remove();
    },
  };
}

async function runGame(
  file: File,
  gameStage: HTMLElement,
  storeHandle: (h: { destroy: () => void }) => void,
): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    storeHandle(await executeZipPreview(file, gameStage, url));
  } catch (error) {
    console.error('Failed to preview game:', error);
    showGameError(gameStage, error);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function executeZipPreview(file: File, gameStage: HTMLElement, url: string): Promise<{ destroy: () => void }> {
  const { executeZip } = await import('./zip-executor.js');
  return executeZip('preview', gameStage, url);
}

function showGameError(gameStage: HTMLElement, error: unknown): void {
  gameStage.innerHTML = `
    <div style="
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 20px;
      text-align: center;
      color: var(--text-muted, #64748b);
      font-size: 0.875rem;
    ">
      <div>${t('composer.preview_play_failed')}</div>
      <div style="font-size: 0.75rem; margin-top: 4px;">${error instanceof Error ? error.message : ''}</div>
    </div>
  `;
}

function formatPreviewSize(bytes: number): string {
  if (bytes < 1024) return t('file_size.bytes', { size: bytes });
  if (bytes < 1024 * 1024) return t('file_size.kb', { size: (bytes / 1024).toFixed(1) });
  return t('file_size.mb', { size: (bytes / (1024 * 1024)).toFixed(1) });
}
