import {
  type AudioEditState,
  defaultAudioEditState,
  encodeAudioFile,
  isAudioStateDirty,
} from '../lib/editor/audio-editor.ts';
import { getFFmpeg, runFFmpeg, terminateFFmpeg } from '../lib/editor/ffmpeg-client.ts';
import {
  buildGifEditArgs,
  defaultImageEditState,
  getOutputSize,
  getSourceSize,
  type ImageAspect,
  type ImageEditState,
  type ImageSource,
  imageFilterCss,
  isImageStateDirty,
  loadImageSource,
  type NormalizedCrop,
  renderImageFile,
} from '../lib/editor/image-editor.ts';
import { computeAudioPlan, defaultTargetBytes, tightenVideoPlan } from '../lib/editor/render-preset.ts';
import { createTrimTimeline, formatTimelineTime, type TrimTimelineHandle } from '../lib/editor/trim-timeline.ts';
import {
  defaultVideoEditState,
  encodeVideoFile,
  isVideoStateDirty,
  planForState,
  probeVideo,
  type VideoEditState,
  type VideoMeta,
} from '../lib/editor/video-editor.ts';
import { computeAudioPeaks } from '../lib/editor/waveform.ts';
import { type AttachPreviewKind, detectAttachKind } from '../lib/file-preview.js';
import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';
import { showToast } from '../lib/toast.js';

/**
 * Browser-side editing needs the whole file in RAM (twice for ffmpeg MEM FS).
 * Audio is capped lower: waveform peaks decode the entire track to PCM.
 */
const EDIT_MAX_BYTES: Record<EditableKind, number> = {
  image: 150 * 1024 * 1024,
  video: 150 * 1024 * 1024,
  audio: 40 * 1024 * 1024,
};
const RESOLUTION_OPTIONS = [1080, 720, 480, 360] as const;

type EditableKind = Extract<AttachPreviewKind, 'image' | 'audio' | 'video'>;
type CropCorner = 'nw' | 'ne' | 'sw' | 'se';
type ImageTabId = 'crop' | 'rotate' | 'adjust' | 'size';

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .me-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55);
      display: flex; align-items: center; justify-content: center; z-index: 1200;
    }
    .me-dialog {
      background: var(--bg-primary); border: 1px solid var(--border); border-radius: 12px;
      width: 92%; max-width: 640px; max-height: 90vh; display: flex; flex-direction: column;
      box-shadow: 0 8px 32px rgba(0,0,0,0.35); overflow: hidden;
    }
    .me-header {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 10px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .me-header-title { font-size: 0.95rem; font-weight: 700; color: var(--text-primary); min-width: 0; }
    .me-header-file {
      display: block; font-size: 0.75rem; font-weight: 400; color: var(--text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px;
    }
    .me-icon-btn {
      background: none; border: none; color: var(--text-muted); cursor: pointer;
      font-size: 1.2rem; line-height: 1; padding: 4px 8px; border-radius: 6px;
    }
    .me-icon-btn:hover { background: var(--bg-secondary); color: var(--text-primary); }
    .me-icon-btn:disabled { opacity: 0.4; cursor: default; }
    .me-body {
      padding: 14px 16px; display: flex; flex-direction: column; gap: 12px;
      overflow-y: auto; min-height: 0; flex: 1;
    }
    .me-preview {
      position: relative; display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.25); border-radius: 8px; min-height: 160px;
      max-height: 44vh; overflow: hidden;
    }
    .me-canvas-wrap { position: relative; display: inline-block; line-height: 0; max-width: 100%; }
    .me-canvas-wrap canvas {
      display: block; max-width: 100%; max-height: 40vh;
      filter: brightness(100%) contrast(100%);
    }
    .me-crop-layer { position: absolute; inset: 0; touch-action: none; cursor: crosshair; }
    .me-crop-rect {
      position: absolute; box-shadow: 0 0 0 9999px rgba(0,0,0,0.55);
      border: 1px solid rgba(255,255,255,0.9); cursor: move; touch-action: none;
    }
    .me-crop-handle {
      position: absolute; width: 14px; height: 14px; background: #fff; border: 1px solid var(--accent, #6366f1);
      border-radius: 3px; touch-action: none;
    }
    .me-video { width: 100%; max-height: 36vh; background: #000; border-radius: 8px; display: block; }
    .me-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .me-tab {
      background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-muted);
      border-radius: 999px; padding: 6px 14px; font-size: 0.8rem; cursor: pointer;
    }
    .me-tab.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .me-panel { display: flex; flex-direction: column; gap: 10px; }
    .me-btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .me-tool-btn {
      background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary);
      border-radius: 8px; padding: 8px 12px; font-size: 0.82rem; cursor: pointer;
    }
    .me-tool-btn:hover { border-color: var(--accent); }
    .me-tool-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
    .me-tool-btn:disabled { opacity: 0.5; cursor: default; }
    .me-slider-row { display: flex; align-items: center; gap: 10px; font-size: 0.82rem; color: var(--text-primary); }
    .me-slider-row label { width: 92px; flex-shrink: 0; color: var(--text-muted); }
    .me-slider-row input[type='range'] { flex: 1; accent-color: var(--accent); min-width: 0; }
    .me-slider-value { width: 52px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .me-check-row { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: var(--text-primary); }
    .me-select {
      background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary);
      border-radius: 8px; padding: 7px 10px; font-size: 0.82rem;
    }
    .me-trim-label { font-size: 0.8rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .me-estimate {
      display: flex; justify-content: space-between; gap: 10px; font-size: 0.78rem;
      color: var(--text-muted); min-height: 1.1em; flex-wrap: wrap;
    }
    .me-estimate-ok { color: #34d399; }
    .me-estimate-bad { color: var(--danger, #f87171); }
    .me-status { font-size: 0.8rem; color: var(--text-muted); text-align: center; }
    .me-progress { display: none; flex-direction: column; gap: 6px; }
    .me-progress.visible { display: flex; }
    .me-progress-track { height: 6px; background: var(--bg-secondary); border-radius: 999px; overflow: hidden; }
    .me-progress-bar { height: 100%; width: 0%; background: var(--accent); border-radius: 999px; transition: width 0.15s ease; }
    .me-footer {
      display: flex; justify-content: flex-end; gap: 10px; padding: 12px 16px;
      border-top: 1px solid var(--border); flex-shrink: 0;
    }
    .me-cancel-btn {
      background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary);
      border-radius: 8px; padding: 9px 18px; font-size: 0.88rem; cursor: pointer;
    }
    .me-apply-btn {
      background: var(--accent); border: 1px solid var(--accent); color: #fff;
      border-radius: 8px; padding: 9px 22px; font-size: 0.88rem; font-weight: 600; cursor: pointer;
    }
    .me-cancel-btn:disabled, .me-apply-btn:disabled { opacity: 0.5; cursor: default; }
    .me-loading-box {
      display: flex; align-items: center; justify-content: center; min-height: 140px;
      color: var(--text-muted); font-size: 0.85rem;
    }
  `;
  document.head.appendChild(style);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return t('file_size.bytes', { size: Math.round(bytes) });
  if (bytes < 1024 * 1024) return t('file_size.kb', { size: (bytes / 1024).toFixed(1) });
  return t('file_size.mb', { size: (bytes / (1024 * 1024)).toFixed(1) });
}

function safeBaseName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

function fileExt(name: string): string {
  return (name.toLowerCase().split('.').pop() || '').replace(/[^a-z0-9]/g, '');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFullCrop(crop: NormalizedCrop | null): boolean {
  return !crop || (crop.x <= 0.001 && crop.y <= 0.001 && crop.w >= 0.999 && crop.h >= 0.999);
}

function aspectRatioOf(kind: ImageAspect): number | null {
  switch (kind) {
    case '1:1':
      return 1;
    case '4:3':
      return 4 / 3;
    case '16:9':
      return 16 / 9;
    case '9:16':
      return 9 / 16;
    default:
      return null;
  }
}

function conformCropToAspect(rect: NormalizedCrop, ar: number | null, imgW: number, imgH: number): NormalizedCrop {
  if (!ar) return rect;
  const originalW = rect.w;
  const originalH = rect.h;
  let w = rect.w;
  let h = (w * imgW) / (ar * imgH);
  if (rect.y + h > 1) {
    h = 1 - rect.y;
    w = (h * imgH * ar) / imgW;
  }
  if (w > 1) {
    w = 1;
    h = (w * imgW) / (ar * imgH);
  }
  const x = clamp(rect.x + (originalW - w) / 2, 0, 1 - w);
  const y = clamp(rect.y + (originalH - h) / 2, 0, 1 - h);
  return { x, y, w, h };
}

function resizeCrop(
  rect: NormalizedCrop,
  corner: CropCorner,
  px: number,
  py: number,
  ar: number | null,
  imgW: number,
  imgH: number,
): NormalizedCrop {
  const anchorX = corner === 'nw' || corner === 'sw' ? rect.x + rect.w : rect.x;
  const anchorY = corner === 'nw' || corner === 'ne' ? rect.y + rect.h : rect.y;
  px = clamp(px, 0, 1);
  py = clamp(py, 0, 1);
  let w = Math.abs(px - anchorX);
  let h = Math.abs(py - anchorY);
  if (ar) {
    const pxW = w * imgW;
    const pxH = h * imgH;
    if (pxW / Math.max(pxH, 1e-6) > ar) h = pxW / ar / imgH;
    else w = (pxH * ar) / imgW;
  }
  const minW = Math.max(0.004, 8 / imgW);
  const minH = Math.max(0.004, 8 / imgH);
  w = Math.max(w, minW);
  h = Math.max(h, minH);
  let x = corner === 'nw' || corner === 'sw' ? anchorX - w : anchorX;
  let y = corner === 'nw' || corner === 'ne' ? anchorY - h : anchorY;
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  return { x, y, w, h };
}

interface SliderRow {
  row: HTMLElement;
  input: HTMLInputElement;
  value: HTMLElement;
}

function makeSlider(options: {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}): SliderRow {
  const row = document.createElement('div');
  row.className = 'me-slider-row';
  const label = document.createElement('label');
  label.textContent = options.label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step ?? 1);
  input.value = String(options.value);
  const value = document.createElement('span');
  value.className = 'me-slider-value';
  const format = options.format ?? ((v: number) => `${v}`);
  value.textContent = format(options.value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    value.textContent = format(v);
    options.onInput(v);
  });
  row.appendChild(label);
  row.appendChild(input);
  row.appendChild(value);
  return { row, input, value };
}

function makeToolButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'me-tool-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Opens the modal editor for an attached image/audio/video file. Resolves with
 * the (possibly re-encoded) file on Apply, or the original file when the user
 * made no changes, and null on cancel.
 */
export function openMediaEditor(file: File): Promise<File | null> {
  const kind = detectAttachKind(file);
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video') {
    return Promise.resolve(null);
  }
  const maxBytes = EDIT_MAX_BYTES[kind];
  if (file.size > maxBytes) {
    showToast(t('editor.input_too_large', { max: `${Math.floor(maxBytes / (1024 * 1024))}MB` }), true);
    return Promise.resolve(null);
  }
  return new Promise<File | null>((resolve) => {
    const session = new MediaEditorSession(file, kind as EditableKind, resolve);
    session.start();
  });
}

class MediaEditorSession {
  private readonly file: File;
  private readonly kind: EditableKind;
  private readonly resolveFn: (file: File | null) => void;
  private readonly unregister: () => void;
  private readonly overlay: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private closed = false;
  private busy = false;

  // Image
  private imgState: ImageEditState = defaultImageEditState();
  private imgSource: ImageSource | null = null;
  private imgW = 0;
  private imgH = 0;
  private orientedCache: { key: string; canvas: HTMLCanvasElement } | null = null;
  private cropMode = false;
  private aspect: ImageAspect = 'free';
  private activeCrop: NormalizedCrop = { x: 0, y: 0, w: 1, h: 1 };
  private previewCanvas: HTMLCanvasElement | null = null;
  private cropLayer: HTMLDivElement | null = null;
  private cropRectEl: HTMLDivElement | null = null;
  private estimateTimer: ReturnType<typeof setTimeout> | null = null;
  private estimateToken = 0;
  private cancelled = false;
  private imageTabs: HTMLElement | null = null;
  private imagePanelHost: HTMLElement | null = null;
  private imageTab: ImageTabId = 'crop';

  // Audio
  private audioState: AudioEditState | null = null;
  private audioDuration = 0;
  private audioTimeline: TrimTimelineHandle | null = null;
  private audioTrimLabel: HTMLElement | null = null;

  // Video
  private videoState: VideoEditState | null = null;
  private videoMeta: VideoMeta | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private videoTimeline: TrimTimelineHandle | null = null;
  private videoTrimLabel: HTMLElement | null = null;

  // Shared footer
  private estimateSizeEl: HTMLElement | null = null;
  private estimateBudgetEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private applyBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private closeBtn: HTMLButtonElement | null = null;
  private objectUrls: string[] = [];

  constructor(file: File, kind: EditableKind, resolveFn: (file: File | null) => void) {
    injectStyles();
    this.file = file;
    this.kind = kind;
    this.resolveFn = resolveFn;
    this.unregister = registerModal();

    this.overlay = document.createElement('div');
    this.overlay.className = 'me-overlay';
    this.dialog = document.createElement('div');
    this.dialog.className = 'me-dialog';
    this.overlay.appendChild(this.dialog);
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close(null);
    });
    document.addEventListener('keydown', this.onKeyDown);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !this.busy) {
      e.stopPropagation();
      this.close(null);
    }
  };

  start(): void {
    document.body.appendChild(this.overlay);
    this.buildHeader();
    const body = document.createElement('div');
    body.className = 'me-body';
    this.dialog.appendChild(body);
    if (this.kind === 'image') this.buildImagePanel(body);
    else if (this.kind === 'audio') void this.buildAudioPanel(body);
    else void this.buildVideoPanel(body);
    this.buildEstimate(body);
    this.buildFooter();
  }

  private close(result: File | null): void {
    if (this.closed || this.busy) return;
    this.closed = true;
    document.removeEventListener('keydown', this.onKeyDown);
    if (this.estimateTimer) clearTimeout(this.estimateTimer);
    this.audioTimeline?.destroy();
    this.videoTimeline?.destroy();
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.load();
    }
    if (this.imgSource instanceof ImageBitmap) this.imgSource.close();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
    this.unregister();
    this.overlay.remove();
    this.resolveFn(result);
  }

  private buildHeader(): void {
    const header = document.createElement('div');
    header.className = 'me-header';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'me-header-title';
    titleWrap.textContent = t('editor.title');
    const fileLabel = document.createElement('span');
    fileLabel.className = 'me-header-file';
    fileLabel.textContent = this.file.name;
    titleWrap.appendChild(fileLabel);
    this.closeBtn = document.createElement('button');
    this.closeBtn.type = 'button';
    this.closeBtn.className = 'me-icon-btn';
    this.closeBtn.setAttribute('aria-label', t('editor.close'));
    this.closeBtn.textContent = '×';
    this.closeBtn.addEventListener('click', () => this.close(null));
    header.appendChild(titleWrap);
    header.appendChild(this.closeBtn);
    this.dialog.appendChild(header);
  }

  private buildEstimate(host: HTMLElement): void {
    const estimate = document.createElement('div');
    estimate.className = 'me-estimate';
    this.estimateSizeEl = document.createElement('span');
    this.estimateBudgetEl = document.createElement('span');
    estimate.appendChild(this.estimateSizeEl);
    estimate.appendChild(this.estimateBudgetEl);
    host.appendChild(estimate);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'me-status';
    this.statusEl.style.display = 'none';
    host.appendChild(this.statusEl);

    this.progressEl = document.createElement('div');
    this.progressEl.className = 'me-progress';
    const track = document.createElement('div');
    track.className = 'me-progress-track';
    this.progressBar = document.createElement('div');
    this.progressBar.className = 'me-progress-bar';
    track.appendChild(this.progressBar);
    this.progressEl.appendChild(track);
    host.appendChild(this.progressEl);

    if (this.kind === 'image' && fileExt(this.file.name) === 'gif') {
      this.estimateSizeEl.textContent = t('editor.estimate_after_apply');
    }
  }

  private buildFooter(): void {
    const footer = document.createElement('div');
    footer.className = 'me-footer';
    this.cancelBtn = document.createElement('button');
    this.cancelBtn.type = 'button';
    this.cancelBtn.className = 'me-cancel-btn';
    this.cancelBtn.textContent = t('editor.cancel');
    this.cancelBtn.addEventListener('click', () => {
      if (this.busy) this.cancelRender();
      else this.close(null);
    });
    this.applyBtn = document.createElement('button');
    this.applyBtn.type = 'button';
    this.applyBtn.className = 'me-apply-btn';
    this.applyBtn.textContent = t('editor.apply');
    this.applyBtn.addEventListener('click', () => void this.onApply());
    footer.appendChild(this.cancelBtn);
    footer.appendChild(this.applyBtn);
    this.dialog.appendChild(footer);
  }

  private setStatus(text: string | null): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = text ?? '';
    this.statusEl.style.display = text ? 'block' : 'none';
  }

  private setProgress(ratio: number | null): void {
    if (!this.progressEl || !this.progressBar) return;
    if (ratio === null) {
      this.progressEl.classList.remove('visible');
      this.progressBar.style.width = '0%';
      return;
    }
    this.progressEl.classList.add('visible');
    this.progressBar.style.width = `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.applyBtn) this.applyBtn.disabled = busy;
    if (this.closeBtn) this.closeBtn.disabled = busy;
  }

  private cancelRender(): void {
    this.cancelled = true;
    terminateFFmpeg();
  }

  private resetRender(): void {
    this.cancelled = false;
    this.setBusy(false);
    this.setProgress(null);
    this.setStatus(null);
  }

  private updateEstimate(size: number | null, fits: boolean | null): void {
    if (!this.estimateSizeEl || !this.estimateBudgetEl) return;
    if (size === null) {
      this.estimateSizeEl.textContent = '';
      this.estimateBudgetEl.textContent = '';
      return;
    }
    this.estimateSizeEl.textContent = t('editor.output_estimate', { size: formatSize(size) });
    if (fits === null) {
      this.estimateBudgetEl.textContent = '';
      this.estimateBudgetEl.className = '';
    } else {
      this.estimateBudgetEl.textContent = fits ? t('editor.fits_budget') : t('editor.exceeds_budget');
      this.estimateBudgetEl.className = fits ? 'me-estimate-ok' : 'me-estimate-bad';
    }
  }

  // ---------------------------------------------------------------- image

  private buildImagePanel(host: HTMLElement): void {
    if (fileExt(this.file.name) === 'gif') {
      // GIF edits route through ffmpeg; warm the core while decoding pixels.
      void getFFmpeg().catch(() => {});
    }
    const preview = document.createElement('div');
    preview.className = 'me-preview';
    const wrap = document.createElement('div');
    wrap.className = 'me-canvas-wrap';
    this.previewCanvas = document.createElement('canvas');
    wrap.appendChild(this.previewCanvas);
    this.cropLayer = document.createElement('div');
    this.cropLayer.className = 'me-crop-layer';
    this.cropLayer.style.display = 'none';
    this.cropRectEl = document.createElement('div');
    this.cropRectEl.className = 'me-crop-rect';
    for (const corner of ['nw', 'ne', 'sw', 'se'] as CropCorner[]) {
      const handle = document.createElement('div');
      handle.className = 'me-crop-handle';
      handle.dataset.corner = corner;
      handle.style.cursor = corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';
      const style: Record<CropCorner, string> = {
        nw: 'left:-7px; top:-7px;',
        ne: 'right:-7px; top:-7px;',
        sw: 'left:-7px; bottom:-7px;',
        se: 'right:-7px; bottom:-7px;',
      };
      handle.style.cssText += style[corner];
      this.cropRectEl.appendChild(handle);
    }
    this.cropLayer.appendChild(this.cropRectEl);
    wrap.appendChild(this.cropLayer);
    preview.appendChild(wrap);
    host.appendChild(preview);

    this.imageTabs = document.createElement('div');
    this.imageTabs.className = 'me-tabs';
    host.appendChild(this.imageTabs);
    this.imagePanelHost = document.createElement('div');
    this.imagePanelHost.className = 'me-panel';
    host.appendChild(this.imagePanelHost);

    const loading = document.createElement('div');
    loading.className = 'me-loading-box';
    loading.textContent = t('editor.loading_media');
    this.imagePanelHost.appendChild(loading);

    this.setupCropDrag();

    void (async () => {
      try {
        const source = await loadImageSource(this.file);
        this.imgSource = source;
        const size = getSourceSize(source);
        this.imgW = size.width;
        this.imgH = size.height;
        this.activeCrop = { x: 0, y: 0, w: 1, h: 1 };
        this.buildImageTabs();
        this.showImageTab(this.imageTab);
        this.renderImagePreview();
        this.scheduleImageEstimate();
      } catch {
        showToast(t('editor.render_failed'), true);
        this.close(null);
      }
    })();
  }

  private buildImageTabs(): void {
    if (!this.imageTabs) return;
    const tabs: Array<{ id: ImageTabId; label: string }> = [
      { id: 'crop', label: t('editor.tab_crop') },
      { id: 'rotate', label: t('editor.tab_rotate') },
      { id: 'adjust', label: t('editor.tab_adjust') },
      { id: 'size', label: t('editor.tab_resolution') },
    ];
    this.imageTabs.innerHTML = '';
    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `me-tab${this.imageTab === tab.id ? ' active' : ''}`;
      btn.textContent = tab.label;
      btn.addEventListener('click', () => this.showImageTab(tab.id));
      this.imageTabs.appendChild(btn);
    }
  }

  private showImageTab(tab: typeof this.imageTab): void {
    this.imageTab = tab;
    this.cropMode = tab === 'crop';
    this.buildImageTabs();
    if (!this.imagePanelHost) return;
    this.imagePanelHost.innerHTML = '';

    if (tab === 'crop') {
      this.activeCrop = this.imgState.crop ? { ...this.imgState.crop } : { x: 0, y: 0, w: 1, h: 1 };
      const row = document.createElement('div');
      row.className = 'me-btn-row';
      const aspects: Array<{ id: ImageAspect; label: string }> = [
        { id: 'free', label: t('editor.aspect_free') },
        { id: '1:1', label: t('editor.aspect_1_1') },
        { id: '4:3', label: t('editor.aspect_4_3') },
        { id: '16:9', label: t('editor.aspect_16_9') },
        { id: '9:16', label: t('editor.aspect_9_16') },
      ];
      for (const a of aspects) {
        const btn = makeToolButton(a.label, () => {
          this.aspect = a.id;
          this.activeCrop = conformCropToAspect(
            this.activeCrop,
            aspectRatioOf(a.id),
            this.orientedWidth(),
            this.orientedHeight(),
          );
          this.commitCrop();
          this.showImageTab('crop');
        });
        if (this.aspect === a.id) btn.classList.add('active');
        row.appendChild(btn);
      }
      row.appendChild(
        makeToolButton(t('editor.crop_reset'), () => {
          this.activeCrop = { x: 0, y: 0, w: 1, h: 1 };
          this.commitCrop();
        }),
      );
      this.imagePanelHost.appendChild(row);
      const hint = document.createElement('div');
      hint.className = 'me-trim-label';
      hint.textContent = `${this.imgW} × ${this.imgH}`;
      this.imagePanelHost.appendChild(hint);
    } else if (tab === 'rotate') {
      const row = document.createElement('div');
      row.className = 'me-btn-row';
      row.appendChild(
        makeToolButton(t('editor.rotate_left'), () => {
          this.rotateBy(-90);
        }),
      );
      row.appendChild(
        makeToolButton(t('editor.rotate_right'), () => {
          this.rotateBy(90);
        }),
      );
      row.appendChild(
        makeToolButton(t('editor.flip_h'), () => {
          this.imgState = { ...this.imgState, flipX: !this.imgState.flipX };
          this.onImageStateChanged();
        }),
      );
      row.appendChild(
        makeToolButton(t('editor.flip_v'), () => {
          this.imgState = { ...this.imgState, flipY: !this.imgState.flipY };
          this.onImageStateChanged();
        }),
      );
      this.imagePanelHost.appendChild(row);
    } else if (tab === 'adjust') {
      this.imagePanelHost.appendChild(
        makeSlider({
          label: t('editor.brightness'),
          min: 50,
          max: 150,
          value: this.imgState.brightness,
          format: (v) => `${v}%`,
          onInput: (v) => {
            this.imgState = { ...this.imgState, brightness: v };
            this.onImageStateChanged();
          },
        }).row,
      );
      this.imagePanelHost.appendChild(
        makeSlider({
          label: t('editor.contrast'),
          min: 50,
          max: 150,
          value: this.imgState.contrast,
          format: (v) => `${v}%`,
          onInput: (v) => {
            this.imgState = { ...this.imgState, contrast: v };
            this.onImageStateChanged();
          },
        }).row,
      );
    } else {
      const label = document.createElement('label');
      label.className = 'me-trim-label';
      label.textContent = t('editor.tab_resolution');
      const select = document.createElement('select');
      select.className = 'me-select';
      const longEdge = Math.max(this.orientedWidth(), this.orientedHeight());
      const options: Array<{ value: string; label: string }> = [
        { value: 'source', label: t('editor.resolution_source') },
        { value: 'auto', label: t('editor.resolution_auto') },
        ...[4096, 2048, 1600, 1200, 800]
          .filter((px) => px < longEdge)
          .map((px) => ({ value: String(px), label: t('editor.resolution_long_edge', { size: px }) })),
      ];
      const current =
        this.imgState.maxLongEdge === null
          ? 'source'
          : this.imgState.autoLongEdge
            ? 'auto'
            : String(this.imgState.maxLongEdge);
      for (const opt of options) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === current) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', () => {
        const v = select.value;
        if (v === 'source') {
          this.imgState = { ...this.imgState, maxLongEdge: null, autoLongEdge: false };
        } else if (v === 'auto') {
          this.imgState = { ...this.imgState, maxLongEdge: this.autoImageLongEdge(), autoLongEdge: true };
        } else {
          this.imgState = { ...this.imgState, maxLongEdge: Number(v), autoLongEdge: false };
        }
        this.onImageStateChanged();
      });
      this.imagePanelHost.appendChild(label);
      this.imagePanelHost.appendChild(select);
    }

    this.renderImagePreview();
  }

  /** Heuristic: ~1.2 bytes/px JPEG at default quality fits the 25MB budget. */
  private autoImageLongEdge(): number {
    const target = defaultTargetBytes();
    const maxPixels = Math.max(64 * 64, Math.floor(target / 1.2));
    const longEdge = Math.max(this.orientedWidth(), this.orientedHeight());
    const pixels = this.orientedWidth() * this.orientedHeight();
    if (pixels <= maxPixels) return longEdge;
    const scale = Math.sqrt(maxPixels / pixels);
    return Math.max(64, Math.floor(Math.max(this.orientedWidth(), this.orientedHeight()) * scale));
  }

  private orientedWidth(): number {
    return this.imgState.rotation === 90 || this.imgState.rotation === 270 ? this.imgH : this.imgW;
  }

  private orientedHeight(): number {
    return this.imgState.rotation === 90 || this.imgState.rotation === 270 ? this.imgW : this.imgH;
  }

  private rotateBy(delta: number): void {
    const next = (((this.imgState.rotation + delta) % 360) + 360) % 360;
    this.imgState = { ...this.imgState, rotation: next as ImageEditState['rotation'] };
    this.activeCrop = { x: 0, y: 0, w: 1, h: 1 };
    this.commitCrop();
    this.onImageStateChanged();
  }

  private commitCrop(): void {
    this.imgState = {
      ...this.imgState,
      crop: isFullCrop(this.activeCrop) ? null : { ...this.activeCrop },
    };
    this.renderImagePreview();
    this.scheduleImageEstimate();
  }

  private onImageStateChanged(): void {
    this.orientedCache = null;
    this.renderImagePreview();
    this.scheduleImageEstimate();
  }

  private getOrientedCanvas(): HTMLCanvasElement {
    const key = `${this.imgState.rotation}|${this.imgState.flipX ? 1 : 0}|${this.imgState.flipY ? 1 : 0}`;
    if (this.orientedCache?.key === key) return this.orientedCache.canvas;
    if (!this.imgSource) throw new Error('no image');
    const flipped = document.createElement('canvas');
    flipped.width = this.imgW;
    flipped.height = this.imgH;
    const fctx = flipped.getContext('2d');
    if (!fctx) throw new Error('canvas unavailable');
    if (this.imgState.flipX || this.imgState.flipY) {
      fctx.translate(this.imgState.flipX ? this.imgW : 0, this.imgState.flipY ? this.imgH : 0);
      fctx.scale(this.imgState.flipX ? -1 : 1, this.imgState.flipY ? -1 : 1);
    }
    fctx.drawImage(this.imgSource as CanvasImageSource, 0, 0, this.imgW, this.imgH);

    const w = this.orientedWidth();
    const h = this.orientedHeight();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    const rot = this.imgState.rotation;
    if (rot === 90) {
      ctx.translate(w, 0);
      ctx.rotate(Math.PI / 2);
    } else if (rot === 180) {
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
    } else if (rot === 270) {
      ctx.translate(0, h);
      ctx.rotate(-Math.PI / 2);
    }
    ctx.drawImage(flipped, 0, 0);
    this.orientedCache = { key, canvas };
    return canvas;
  }

  private renderImagePreview(): void {
    const canvas = this.previewCanvas;
    if (!canvas || !this.imgSource) return;
    const oriented = this.getOrientedCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (this.cropMode) {
      canvas.width = oriented.width;
      canvas.height = oriented.height;
      ctx.drawImage(oriented, 0, 0);
      if (this.cropLayer) {
        this.cropLayer.style.display = 'block';
        this.layoutCropRect();
      }
    } else {
      const crop = this.imgState.crop;
      const sx = crop ? Math.floor(crop.x * oriented.width) : 0;
      const sy = crop ? Math.floor(crop.y * oriented.height) : 0;
      const sw = crop ? Math.max(1, Math.round(crop.w * oriented.width)) : oriented.width;
      const sh = crop ? Math.max(1, Math.round(crop.h * oriented.height)) : oriented.height;
      const out = getOutputSize(this.imgW, this.imgH, this.imgState);
      const maxPreview = 1024;
      let dw = Math.min(out.width, maxPreview);
      let dh = Math.min(out.height, maxPreview);
      if (sw / sh > dw / dh) dh = Math.max(1, Math.round((dw * sh) / sw));
      else dw = Math.max(1, Math.round((sw / sh) * dh));
      canvas.width = dw;
      canvas.height = dh;
      ctx.drawImage(oriented, sx, sy, sw, sh, 0, 0, dw, dh);
      if (this.cropLayer) this.cropLayer.style.display = 'none';
    }
    canvas.style.filter = imageFilterCss(this.imgState);
    if (this.imgState.crop) {
      this.activeCrop = { ...this.imgState.crop };
    }
  }

  private layoutCropRect(): void {
    if (!this.cropRectEl || !this.cropLayer) return;
    const c = this.activeCrop;
    this.cropRectEl.style.left = `${c.x * 100}%`;
    this.cropRectEl.style.top = `${c.y * 100}%`;
    this.cropRectEl.style.width = `${c.w * 100}%`;
    this.cropRectEl.style.height = `${c.h * 100}%`;
  }

  private setupCropDrag(): void {
    if (!this.cropLayer || !this.cropRectEl) return;
    let mode: { type: 'move' } | { type: 'resize'; corner: CropCorner } | null = null;
    let startX = 0;
    let startY = 0;
    let startRect: NormalizedCrop = { x: 0, y: 0, w: 1, h: 1 };

    const normFromEvent = (e: PointerEvent): { x: number; y: number } => {
      const rect = this.cropLayer!.getBoundingClientRect();
      return {
        x: clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
        y: clamp((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
      };
    };

    const onMove = (e: PointerEvent): void => {
      if (!mode) return;
      const p = normFromEvent(e);
      if (mode.type === 'move') {
        const dx = p.x - startX;
        const dy = p.y - startY;
        this.activeCrop = {
          ...startRect,
          x: clamp(startRect.x + dx, 0, 1 - startRect.w),
          y: clamp(startRect.y + dy, 0, 1 - startRect.h),
        };
      } else {
        this.activeCrop = resizeCrop(
          startRect,
          mode.corner,
          p.x,
          p.y,
          aspectRatioOf(this.aspect),
          this.orientedWidth(),
          this.orientedHeight(),
        );
      }
      this.layoutCropRect();
      e.preventDefault();
    };

    const onUp = (): void => {
      if (!mode) return;
      mode = null;
      this.commitCrop();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    this.cropRectEl.addEventListener('pointerdown', (e) => {
      if (this.busy) return;
      const target = e.target as HTMLElement;
      const corner = target.dataset.corner as CropCorner | undefined;
      mode = corner ? { type: 'resize', corner } : { type: 'move' };
      const p = normFromEvent(e);
      startX = p.x;
      startY = p.y;
      startRect = { ...this.activeCrop };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  private scheduleImageEstimate(): void {
    if (this.kind !== 'image') return;
    if (fileExt(this.file.name) === 'gif') return;
    if (this.estimateTimer) clearTimeout(this.estimateTimer);
    const token = ++this.estimateToken;
    this.estimateTimer = setTimeout(() => {
      void (async () => {
        if (!this.imgSource || token !== this.estimateToken || this.closed) return;
        try {
          if (!isImageStateDirty(this.imgState)) {
            this.updateEstimate(this.file.size, this.file.size <= defaultTargetBytes());
            return;
          }
          const { blob } = await renderImageFile(this.imgSource, this.imgState, fileExt(this.file.name));
          if (token !== this.estimateToken || this.closed) return;
          this.updateEstimate(blob.size, blob.size <= defaultTargetBytes());
        } catch {
          if (token === this.estimateToken) this.updateEstimate(null, null);
        }
      })();
    }, 500);
  }

  // ---------------------------------------------------------------- audio

  private async buildAudioPanel(host: HTMLElement): Promise<void> {
    // Warm the encoder core in the background while the waveform decodes.
    void getFFmpeg().catch(() => {});
    const preview = document.createElement('div');
    preview.className = 'me-preview';
    preview.style.flexDirection = 'column';
    preview.style.gap = '8px';
    preview.style.padding = '10px';
    preview.style.alignItems = 'stretch';
    const loading = document.createElement('div');
    loading.className = 'me-loading-box';
    loading.textContent = t('editor.loading_media');
    preview.appendChild(loading);
    host.appendChild(preview);

    try {
      const { peaks, duration } = await computeAudioPeaks(this.file);
      if (this.closed) return;
      this.audioDuration = duration;
      this.audioState = defaultAudioEditState(duration);
      preview.innerHTML = '';

      this.audioTimeline = createTrimTimeline({
        duration,
        peaks,
        onChange: (range) => {
          if (!this.audioState) return;
          this.audioState = { ...this.audioState, start: range.start, end: range.end };
          this.updateAudioTrimLabel();
          this.updateAudioEstimate();
        },
      });
      preview.appendChild(this.audioTimeline.el);

      this.audioTrimLabel = document.createElement('div');
      this.audioTrimLabel.className = 'me-trim-label';
      preview.appendChild(this.audioTrimLabel);

      const controls = document.createElement('div');
      controls.className = 'me-panel';
      const muteRow = document.createElement('div');
      muteRow.className = 'me-check-row';
      const mute = document.createElement('input');
      mute.type = 'checkbox';
      mute.id = 'me-audio-mute';
      const muteLabel = document.createElement('label');
      muteLabel.htmlFor = 'me-audio-mute';
      muteLabel.textContent = t('editor.mute');
      mute.addEventListener('change', () => {
        if (!this.audioState) return;
        this.audioState = { ...this.audioState, muted: mute.checked };
        this.syncAudioEstimateDirty();
      });
      muteRow.appendChild(mute);
      muteRow.appendChild(muteLabel);
      const volume = makeSlider({
        label: t('editor.volume'),
        min: 0,
        max: 200,
        value: 100,
        format: (v) => `${v}%`,
        onInput: (v) => {
          if (!this.audioState) return;
          mute.checked = false;
          this.audioState = { ...this.audioState, volume: v, muted: false };
          this.syncAudioEstimateDirty();
        },
      });
      controls.appendChild(volume.row);
      controls.appendChild(muteRow);
      host.appendChild(controls);

      this.updateAudioTrimLabel();
      this.updateAudioEstimate();
    } catch {
      if (this.closed) return;
      showToast(t('editor.render_failed'), true);
      this.close(null);
    }
  }

  private updateAudioTrimLabel(): void {
    if (!this.audioTrimLabel || !this.audioState) return;
    const range = `${formatTimelineTime(this.audioState.start)} – ${formatTimelineTime(this.audioState.end)}`;
    const length = formatTimelineTime(Math.max(0, this.audioState.end - this.audioState.start));
    this.audioTrimLabel.textContent = t('editor.trim_length', { range, length });
  }

  private syncAudioEstimateDirty(): void {
    this.updateAudioEstimate();
  }

  private updateAudioEstimate(): void {
    if (!this.audioState) return;
    if (!isAudioStateDirty(this.audioState, this.audioDuration)) {
      this.updateEstimate(this.file.size, this.file.size <= defaultTargetBytes());
      return;
    }
    const plan = computeAudioPlan(Math.max(0.05, this.audioState.end - this.audioState.start));
    this.updateEstimate(plan.estimatedBytes, plan.fitsBudget);
  }

  // ---------------------------------------------------------------- video

  private async buildVideoPanel(host: HTMLElement): Promise<void> {
    // Warm the encoder core in the background while metadata probes.
    void getFFmpeg().catch(() => {});
    const preview = document.createElement('div');
    preview.className = 'me-preview';
    preview.style.flexDirection = 'column';
    preview.style.gap = '8px';
    preview.style.padding = '10px';
    preview.style.alignItems = 'stretch';
    const loading = document.createElement('div');
    loading.className = 'me-loading-box';
    loading.textContent = t('editor.loading_media');
    preview.appendChild(loading);
    host.appendChild(preview);

    try {
      const meta = await probeVideo(this.file);
      if (this.closed) return;
      this.videoMeta = meta;
      this.videoState = defaultVideoEditState(meta);
      preview.innerHTML = '';

      const url = URL.createObjectURL(this.file);
      this.objectUrls.push(url);
      const video = document.createElement('video');
      video.className = 'me-video';
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      this.videoEl = video;
      preview.appendChild(video);

      this.videoTimeline = createTrimTimeline({
        duration: meta.duration,
        onChange: (range) => {
          if (!this.videoState) return;
          this.videoState = { ...this.videoState, start: range.start, end: range.end };
          if (video.currentTime < range.start || video.currentTime > range.end) {
            try {
              video.currentTime = range.start;
            } catch {
              /* ignore seek errors */
            }
          }
          this.updateVideoTrimLabel();
          this.updateVideoEstimate();
        },
      });
      preview.appendChild(this.videoTimeline.el);

      this.videoTrimLabel = document.createElement('div');
      this.videoTrimLabel.className = 'me-trim-label';
      preview.appendChild(this.videoTrimLabel);

      video.addEventListener('timeupdate', () => {
        if (!this.videoState) return;
        if (video.currentTime > this.videoState.end + 0.1 || video.currentTime < this.videoState.start - 0.1) {
          try {
            video.currentTime = this.videoState.start;
          } catch {
            /* ignore */
          }
        }
      });

      const controls = document.createElement('div');
      controls.className = 'me-panel';

      const muteRow = document.createElement('div');
      muteRow.className = 'me-check-row';
      const mute = document.createElement('input');
      mute.type = 'checkbox';
      mute.id = 'me-video-mute';
      const muteLabel = document.createElement('label');
      muteLabel.htmlFor = 'me-video-mute';
      muteLabel.textContent = t('editor.mute');
      mute.addEventListener('change', () => {
        if (!this.videoState) return;
        this.videoState = { ...this.videoState, muted: mute.checked };
        video.muted = mute.checked;
        this.updateVideoEstimate();
      });
      muteRow.appendChild(mute);
      muteRow.appendChild(muteLabel);

      const volume = makeSlider({
        label: t('editor.volume'),
        min: 0,
        max: 200,
        value: 100,
        format: (v) => `${v}%`,
        onInput: (v) => {
          if (!this.videoState) return;
          mute.checked = false;
          this.videoState = { ...this.videoState, volume: v, muted: false };
          video.muted = false;
          video.volume = clamp(v / 100, 0, 1);
          this.updateVideoEstimate();
        },
      });

      const brightness = makeSlider({
        label: t('editor.brightness'),
        min: 50,
        max: 150,
        value: 100,
        format: (v) => `${v}%`,
        onInput: (v) => {
          if (!this.videoState) return;
          this.videoState = { ...this.videoState, brightness: v };
          video.style.filter = `brightness(${v}%) contrast(${this.videoState.contrast}%)`;
          this.updateVideoEstimate();
        },
      });
      const contrast = makeSlider({
        label: t('editor.contrast'),
        min: 50,
        max: 150,
        value: 100,
        format: (v) => `${v}%`,
        onInput: (v) => {
          if (!this.videoState) return;
          this.videoState = { ...this.videoState, contrast: v };
          video.style.filter = `brightness(${this.videoState.brightness}%) contrast(${v}%)`;
          this.updateVideoEstimate();
        },
      });

      const resRow = document.createElement('div');
      resRow.className = 'me-slider-row';
      const resLabel = document.createElement('label');
      resLabel.textContent = t('editor.tab_resolution');
      const resSelect = document.createElement('select');
      resSelect.className = 'me-select';
      resSelect.style.flex = '1';
      const sourceLongEdge = Math.max(meta.width, meta.height);
      const resOptions: Array<{ value: string; label: string }> = [
        { value: 'auto', label: t('editor.resolution_auto') },
        { value: 'source', label: t('editor.resolution_source') },
        ...RESOLUTION_OPTIONS.filter((px) => px < sourceLongEdge).map((px) => ({
          value: String(px),
          label: t('editor.resolution_long_edge', { size: px }),
        })),
      ];
      for (const opt of resOptions) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        resSelect.appendChild(option);
      }
      resSelect.addEventListener('change', () => {
        if (!this.videoState) return;
        const v = resSelect.value;
        this.videoState = {
          ...this.videoState,
          resolution: v === 'auto' || v === 'source' ? v : Number(v),
        };
        this.updateVideoEstimate();
      });
      resRow.appendChild(resLabel);
      resRow.appendChild(resSelect);

      controls.appendChild(volume.row);
      controls.appendChild(muteRow);
      controls.appendChild(brightness.row);
      controls.appendChild(contrast.row);
      controls.appendChild(resRow);
      host.appendChild(controls);

      video.volume = 1;
      this.updateVideoTrimLabel();
      this.updateVideoEstimate();
    } catch {
      if (this.closed) return;
      showToast(t('editor.render_failed'), true);
      this.close(null);
    }
  }

  private updateVideoTrimLabel(): void {
    if (!this.videoTrimLabel || !this.videoState) return;
    const range = `${formatTimelineTime(this.videoState.start)} – ${formatTimelineTime(this.videoState.end)}`;
    const length = formatTimelineTime(Math.max(0, this.videoState.end - this.videoState.start));
    this.videoTrimLabel.textContent = t('editor.trim_length', { range, length });
  }

  private updateVideoEstimate(): void {
    if (!this.videoState || !this.videoMeta) return;
    if (!isVideoStateDirty(this.videoState)) {
      this.updateEstimate(this.file.size, this.file.size <= defaultTargetBytes());
      return;
    }
    const { plan } = planForState(this.videoMeta, this.videoState);
    this.updateEstimate(plan.estimatedBytes, plan.fitsBudget);
  }

  // ---------------------------------------------------------------- apply

  private async onApply(): Promise<void> {
    if (this.busy || this.closed) return;
    this.cancelled = false;
    this.setBusy(true);
    this.setPercentStatus(t('editor.loading_core'));
    this.setProgress(0.02);
    try {
      const result = await this.renderOutput();
      if (this.closed) return;
      if (this.cancelled) {
        this.resetRender();
        return;
      }
      this.setProgress(1);
      this.setBusy(false);
      this.close(result);
    } catch (error) {
      if (this.cancelled) {
        this.resetRender();
        return;
      }
      this.resetRender();
      const message =
        error instanceof Error && error.message === 'output-too-large'
          ? t('editor.too_large_output')
          : t('editor.render_failed');
      showToast(message, true);
    }
  }

  private setPercentStatus(text: string): void {
    this.setStatus(text);
  }

  private async renderOutput(): Promise<File> {
    if (this.kind === 'image') return this.renderImageOutput();
    if (this.kind === 'audio') return this.renderAudioOutput();
    return this.renderVideoOutput();
  }

  private async renderImageOutput(): Promise<File> {
    if (!this.imgSource) throw new Error('no image');
    if (!isImageStateDirty(this.imgState)) return this.file;

    const ext = fileExt(this.file.name);
    const base = safeBaseName(this.file.name) || t('editor.untitled_media');

    if (ext === 'gif') {
      this.setStatus(t('editor.processing'));
      const bytes = new Uint8Array(await this.file.arrayBuffer());
      const inputName = 'input.gif';
      const outputName = 'output.gif';
      const data = await runFFmpeg({
        inputs: [{ name: inputName, data: bytes }],
        args: buildGifEditArgs(this.imgW, this.imgH, this.imgState, inputName, outputName),
        outputName,
        onProgress: (ratio) => this.setProgress(0.1 + ratio * 0.9),
        signal: () => this.cancelled,
      });
      if (data.byteLength > defaultTargetBytes()) throw new Error('output-too-large');
      return new File([data as BlobPart], `${base}.gif`, { type: 'image/gif' });
    }

    const { blob, ext: outExt } = await renderImageFile(this.imgSource, this.imgState, ext);
    return new File([blob], `${base}.${outExt}`, { type: blob.type || 'image/jpeg' });
  }

  private async renderAudioOutput(): Promise<File> {
    if (!this.audioState) throw new Error('no audio state');
    if (!isAudioStateDirty(this.audioState, this.audioDuration)) return this.file;
    this.setStatus(t('editor.processing'));
    return encodeAudioFile(this.file, this.audioState, {
      onProgress: (ratio) => this.setProgress(0.1 + ratio * 0.9),
      signal: () => this.cancelled,
    });
  }

  private async renderVideoOutput(): Promise<File> {
    if (!this.videoState || !this.videoMeta) throw new Error('no video state');
    if (!isVideoStateDirty(this.videoState)) return this.file;
    this.setStatus(t('editor.processing'));
    return encodeVideoFile(this.file, this.videoMeta, this.videoState, {
      onProgress: (ratio) => this.setProgress(0.1 + ratio * 0.9),
      tighten: tightenVideoPlan,
      signal: () => this.cancelled,
    });
  }
}
