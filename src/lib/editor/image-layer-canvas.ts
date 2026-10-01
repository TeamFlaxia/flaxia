import { imageLayerCanvasFilter, imageLayerSourceRect } from './image-adjustments.ts';
import type { StudioImageLayer } from './studio-project-store.ts';

export const STUDIO_IMAGE_BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
] as const;

export type StudioImageBlendMode = (typeof STUDIO_IMAGE_BLEND_MODES)[number];

export function isStudioImageBlendMode(value: unknown): value is StudioImageBlendMode {
  return typeof value === 'string' && STUDIO_IMAGE_BLEND_MODES.some((mode) => mode === value);
}

export interface StudioLayerCanvasOptions {
  scale?: number;
  offsetX?: number;
  offsetY?: number;
  opacity?: number;
}

/** Draw one image or text layer using the shared 1080×1080 composition coordinates. */
export function drawStudioImageLayer(
  context: CanvasRenderingContext2D,
  layer: StudioImageLayer,
  bitmap: ImageBitmap | null,
  options: StudioLayerCanvasOptions = {},
): void {
  const scale = options.scale ?? 1;
  const opacity = Math.max(0, Math.min(1, options.opacity ?? layer.opacity));
  if (opacity <= 0 || !layer.visible) return;
  context.save();
  context.globalAlpha = opacity;
  context.globalCompositeOperation = layer.blend === 'normal' ? 'source-over' : layer.blend;
  if (layer.kind === 'image') context.filter = imageLayerCanvasFilter(layer);
  context.translate(
    (options.offsetX ?? 0) + (layer.x + layer.width / 2) * scale,
    (options.offsetY ?? 0) + (layer.y + layer.height / 2) * scale,
  );
  context.scale(scale, scale);
  context.rotate((layer.rotation * Math.PI) / 180);
  if (layer.kind === 'text') {
    context.beginPath();
    context.rect(-layer.width / 2, -layer.height / 2, layer.width, layer.height);
    context.clip();
    const fontSize = layer.fontSize ?? 72;
    context.fillStyle = layer.color ?? '#ffffff';
    context.font = `${fontSize}px ${layer.fontFamily ?? 'sans-serif'}`;
    context.textBaseline = 'middle';
    (layer.text ?? '')
      .split('\n')
      .slice(0, 20)
      .forEach((line, index) => {
        context.fillText(
          line,
          -layer.width / 2,
          -layer.height / 2 + fontSize * 0.7 + index * fontSize * 1.2,
          layer.width,
        );
      });
  } else {
    if (!bitmap) {
      context.restore();
      return;
    }
    const source = imageLayerSourceRect(layer, bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      source.x,
      source.y,
      source.width,
      source.height,
      -layer.width / 2,
      -layer.height / 2,
      layer.width,
      layer.height,
    );
  }
  context.restore();
}
