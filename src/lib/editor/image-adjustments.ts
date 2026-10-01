import type { StudioImageLayer } from './studio-project-store.ts';

/** Build the shared canvas filter used by the image editor and video compositor. */
export function imageLayerCanvasFilter(layer: StudioImageLayer): string {
  const brightness = Math.max(0, Math.min(200, layer.brightness ?? 100));
  const contrast = Math.max(0, Math.min(200, layer.contrast ?? 100));
  const saturation = Math.max(0, Math.min(200, layer.saturation ?? 100));
  return `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
}
