import type { StudioImageLayer } from './studio-project-store.ts';

/** Build the shared canvas filter used by the image editor and video compositor. */
export function imageLayerCanvasFilter(layer: StudioImageLayer): string {
  const brightness = Math.max(0, Math.min(200, layer.brightness ?? 100));
  const contrast = Math.max(0, Math.min(200, layer.contrast ?? 100));
  const saturation = Math.max(0, Math.min(200, layer.saturation ?? 100));
  return `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
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
