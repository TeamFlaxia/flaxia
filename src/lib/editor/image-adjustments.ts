import type { StudioImageLayer } from './studio-project-store.ts';

export type ImageLayerAdjustments = Pick<
  StudioImageLayer,
  'brightness' | 'contrast' | 'saturation' | 'hueDeg' | 'blurPx'
>;

/** Clamp non-destructive image controls to supported editor ranges. */
export function normalizeImageLayerAdjustments(adjustments: ImageLayerAdjustments): Required<ImageLayerAdjustments> {
  const normalize = (value: number | undefined, fallback: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, typeof value === 'number' && Number.isFinite(value) ? value : fallback));
  return {
    brightness: normalize(adjustments.brightness, 100, 0, 200),
    contrast: normalize(adjustments.contrast, 100, 0, 200),
    saturation: normalize(adjustments.saturation, 100, 0, 200),
    hueDeg: normalize(adjustments.hueDeg, 0, -180, 180),
    blurPx: normalize(adjustments.blurPx, 0, 0, 30),
  };
}

/** Build the shared canvas filter used by the image editor and video compositor. */
export function imageLayerCanvasFilter(layer: ImageLayerAdjustments): string {
  const { brightness, contrast, saturation, hueDeg, blurPx } = normalizeImageLayerAdjustments(layer);
  return `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) hue-rotate(${hueDeg}deg) blur(${blurPx}px)`;
}

/** Return the layer opacity at a timeline time, including its optional video fades. */
export function imageLayerOpacityAt(layer: StudioImageLayer, time: number, duration = Infinity): number {
  const start = layer.start ?? 0;
  const end = Math.min(layer.end ?? duration, duration);
  const fadeIn = Math.max(0, layer.fadeIn ?? 0);
  const fadeOut = Math.max(0, layer.fadeOut ?? 0);
  let opacity = layer.opacity;
  if (fadeIn > 0) opacity *= Math.max(0, Math.min(1, (time - start) / fadeIn));
  if (fadeOut > 0) opacity *= Math.max(0, Math.min(1, (end - time) / fadeOut));
  return Math.max(0, Math.min(1, opacity));
}

/** Map a normalized, non-destructive crop rectangle to source bitmap pixels. */
export function imageLayerSourceRect(
  layer: StudioImageLayer,
  sourceWidth: number,
  sourceHeight: number,
): { x: number; y: number; width: number; height: number } {
  const x = normalized(layer.cropX, 0, 0, 0.99);
  const y = normalized(layer.cropY, 0, 0, 0.99);
  const width = normalized(layer.cropWidth, 1 - x, 0.01, 1 - x);
  const height = normalized(layer.cropHeight, 1 - y, 0.01, 1 - y);
  return { x: x * sourceWidth, y: y * sourceHeight, width: width * sourceWidth, height: height * sourceHeight };
}

function normalized(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value !== undefined && Number.isFinite(value) ? value : fallback));
}
