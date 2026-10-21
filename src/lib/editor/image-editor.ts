import { defaultTargetBytes, IMAGE_EXPORT_BOUNDS } from './render-preset.ts';

export type ImageAspect = 'free' | '1:1' | '4:3' | '16:9' | '9:16';

export interface NormalizedCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageEditState {
  rotation: 0 | 90 | 180 | 270;
  flipX: boolean;
  flipY: boolean;
  /** Crop in normalized coords of the rotated/flipped image (0..1). */
  crop: NormalizedCrop | null;
  /** Percent, 100 = neutral (matches CSS filter semantics). */
  brightness: number;
  contrast: number;
  /** Long-edge cap in px; null keeps the source size. */
  maxLongEdge: number | null;
  /** True when maxLongEdge was derived by the auto preset. */
  autoLongEdge: boolean;
}

export type ImageSource = ImageBitmap | HTMLImageElement;

export function defaultImageEditState(): ImageEditState {
  return {
    rotation: 0,
    flipX: false,
    flipY: false,
    crop: null,
    brightness: 100,
    contrast: 100,
    maxLongEdge: null,
    autoLongEdge: false,
  };
}

export function isImageStateDirty(state: ImageEditState): boolean {
  const d = defaultImageEditState();
  return (
    state.rotation !== d.rotation ||
    state.flipX !== d.flipX ||
    state.flipY !== d.flipY ||
    state.crop !== null ||
    state.brightness !== d.brightness ||
    state.contrast !== d.contrast ||
    state.maxLongEdge !== d.maxLongEdge ||
    state.autoLongEdge !== d.autoLongEdge
  );
}

export function imageFilterCss(state: ImageEditState): string {
  return `brightness(${state.brightness}%) contrast(${state.contrast}%)`;
}

export function getRotatedSize(width: number, height: number, rotation: number): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

export function getSourceSize(source: ImageSource): { width: number; height: number } {
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: source.width, height: source.height };
}

/** Output pixel size for the current state (rotation → crop → long-edge cap). */
export function getOutputSize(
  sourceWidth: number,
  sourceHeight: number,
  state: ImageEditState,
): { width: number; height: number } {
  const rotated = getRotatedSize(sourceWidth, sourceHeight, state.rotation);
  let width = rotated.width;
  let height = rotated.height;
  if (state.crop) {
    width = Math.max(1, Math.round(rotated.width * state.crop.w));
    height = Math.max(1, Math.round(rotated.height * state.crop.h));
  }
  if (state.maxLongEdge) {
    const longEdge = Math.max(width, height);
    if (longEdge > state.maxLongEdge) {
      const scale = state.maxLongEdge / longEdge;
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
  }
  return { width, height };
}

export async function loadImageSource(file: File): Promise<ImageSource> {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image decode failed'));
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function drawFlipped(
  source: ImageSource,
  width: number,
  height: number,
  flipX: boolean,
  flipY: boolean,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  if (flipX || flipY) {
    ctx.translate(flipX ? width : 0, flipY ? height : 0);
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  }
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return canvas;
}

function rotateCanvas(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  rotation: 0 | 90 | 180 | 270,
): HTMLCanvasElement {
  const { width, height } = getRotatedSize(srcW, srcH, rotation);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  if (rotation === 90) {
    ctx.translate(width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    ctx.translate(width, height);
    ctx.rotate(Math.PI);
  } else if (rotation === 270) {
    ctx.translate(0, height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(source, 0, 0, srcW, srcH);
  return canvas;
}

function applyBrightnessContrast(imageData: ImageData, brightness: number, contrast: number): void {
  if (brightness === 100 && contrast === 100) return;
  const bFactor = brightness / 100;
  const cFactor = contrast / 100;
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = i; c < i + 3; c++) {
      let v = data[c] * bFactor;
      v = (v - 127.5) * cFactor + 127.5;
      data[c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

function cropCanvas(oriented: HTMLCanvasElement, crop: NormalizedCrop | null): HTMLCanvasElement {
  if (!crop) return oriented;
  const sx = Math.max(0, Math.floor(crop.x * oriented.width));
  const sy = Math.max(0, Math.floor(crop.y * oriented.height));
  const sw = Math.max(1, Math.min(oriented.width - sx, Math.round(crop.w * oriented.width)));
  const sh = Math.max(1, Math.min(oriented.height - sy, Math.round(crop.h * oriented.height)));
  if (sx === 0 && sy === 0 && sw === oriented.width && sh === oriented.height) return oriented;
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(oriented, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

function scaleCanvas(source: HTMLCanvasElement, targetW: number, targetH: number): HTMLCanvasElement {
  if (source.width === targetW && source.height === targetH) return source;
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, targetW, targetH);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

function outputMimeFor(ext: string): { mime: string; ext: string } {
  if (ext === 'png') return { mime: 'image/png', ext: 'png' };
  if (ext === 'gif') return { mime: 'image/gif', ext: 'gif' };
  return { mime: 'image/jpeg', ext: 'jpg' };
}

/**
 * Full canvas pipeline: flip → rotate → crop → scale → brightness/contrast →
 * export that fits inside the byte budget (quality search for JPEG, downscale
 * steps as a last resort).
 */
export async function renderImageFile(
  source: ImageSource,
  state: ImageEditState,
  sourceExt: string,
  options: { targetBytes?: number } = {},
): Promise<{ blob: Blob; width: number; height: number; ext: string }> {
  const targetBytes = options.targetBytes ?? defaultTargetBytes();
  const { width: srcW, height: srcH } = getSourceSize(source);

  const flipped = drawFlipped(source, srcW, srcH, state.flipX, state.flipY);
  const oriented = rotateCanvas(flipped, srcW, srcH, state.rotation);
  const cropped = cropCanvas(oriented, state.crop);
  const out = getOutputSize(srcW, srcH, state);
  let working = scaleCanvas(cropped, out.width, out.height);

  const ctx = working.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  if (state.brightness !== 100 || state.contrast !== 100) {
    const imageData = ctx.getImageData(0, 0, working.width, working.height);
    applyBrightnessContrast(imageData, state.brightness, state.contrast);
    ctx.putImageData(imageData, 0, 0);
  }

  const { mime, ext } = outputMimeFor(sourceExt);

  if (mime === 'image/png' || mime === 'image/gif') {
    let blob = await canvasToBlob(working, mime);
    let guard = 0;
    while (blob && blob.size > targetBytes && guard < 4 && Math.min(working.width, working.height) > 64) {
      working = scaleCanvas(
        working,
        Math.max(64, Math.floor(working.width * 0.75)),
        Math.max(64, Math.floor(working.height * 0.75)),
      );
      blob = await canvasToBlob(working, mime);
      guard++;
    }
    if (!blob) throw new Error('encode failed');
    return { blob, width: working.width, height: working.height, ext };
  }

  const qualities = [IMAGE_EXPORT_BOUNDS.maxQuality, 0.8, 0.7, 0.6, IMAGE_EXPORT_BOUNDS.minQuality];
  let rounds = 0;
  let current = working;
  while (rounds < 4) {
    for (const quality of qualities) {
      const blob = await canvasToBlob(current, mime, quality);
      if (blob && blob.size <= targetBytes) {
        return { blob, width: current.width, height: current.height, ext };
      }
      if (!blob) throw new Error('encode failed');
    }
    if (Math.min(current.width, current.height) <= 64) break;
    current = scaleCanvas(
      current,
      Math.max(64, Math.floor(current.width * 0.75)),
      Math.max(64, Math.floor(current.height * 0.75)),
    );
    rounds++;
  }
  const finalBlob = await canvasToBlob(current, mime, IMAGE_EXPORT_BOUNDS.minQuality);
  if (!finalBlob) throw new Error('encode failed');
  return { blob: finalBlob, width: current.width, height: current.height, ext };
}

/**
 * ffmpeg args for GIF inputs so animation survives crop/rotate/filter edits.
 * Order matches the canvas pipeline: flips → rotate → crop → scale → eq.
 */
export function buildGifEditArgs(
  sourceWidth: number,
  sourceHeight: number,
  state: ImageEditState,
  inputName: string,
  outputName: string,
): string[] {
  const vf: string[] = [];
  if (state.flipX) vf.push('hflip');
  if (state.flipY) vf.push('vflip');
  if (state.rotation === 90) vf.push('transpose=1');
  else if (state.rotation === 180) vf.push('hflip,vflip');
  else if (state.rotation === 270) vf.push('transpose=2');

  const rotated = getRotatedSize(sourceWidth, sourceHeight, state.rotation);
  if (state.crop) {
    const sx = Math.max(0, Math.round(state.crop.x * rotated.width));
    const sy = Math.max(0, Math.round(state.crop.y * rotated.height));
    const sw = Math.max(1, Math.min(rotated.width - sx, Math.round(state.crop.w * rotated.width)));
    const sh = Math.max(1, Math.min(rotated.height - sy, Math.round(state.crop.h * rotated.height)));
    vf.push(`crop=${sw}:${sh}:${sx}:${sy}`);
    rotated.width = sw;
    rotated.height = sh;
  }

  const out = getOutputSize(sourceWidth, sourceHeight, state);
  if (out.width !== rotated.width || out.height !== rotated.height) {
    vf.push(`scale=${out.width}:${out.height}`);
  }
  if (state.brightness !== 100 || state.contrast !== 100) {
    const b = (state.brightness / 100 - 1).toFixed(3);
    const c = (state.contrast / 100).toFixed(3);
    vf.push(`eq=brightness=${b}:contrast=${c}`);
  }

  const args = ['-i', inputName];
  if (vf.length > 0) args.push('-vf', vf.join(','));
  args.push('-loop', '0', '-f', 'gif', outputName);
  return args;
}
