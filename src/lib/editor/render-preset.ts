/**
 * Pure render-budget math: pick encode settings so the output fits inside
 * the upload cap with margin. Kept dependency-free so tests can cover it.
 */

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Headroom for muxer overhead / encoder overshoot. */
export const TARGET_SAFETY_RATIO = 0.95;

const MIN_VIDEO_KBPS = 150;
const MAX_VIDEO_KBPS = 10_000;
const MIN_AUDIO_KBPS = 64;
const MAX_AUDIO_KBPS = 320;
const DEFAULT_VIDEO_AUDIO_KBPS = 128;
const LOW_VIDEO_AUDIO_KBPS = 64;
const CONTAINER_OVERHEAD_BYTES_PER_SEC = 1024;

const IMAGE_JPEG_MAX_QUALITY = 0.92;
const IMAGE_JPEG_MIN_QUALITY = 0.5;

interface ResolutionRung {
  /** Long-edge cap for the output (landscape ladder). */
  maxLongEdge: number;
  /** Minimum video bitrate that looks acceptable at this size. */
  minKbps: number;
}

/** Largest first. */
const RESOLUTION_LADDER: ResolutionRung[] = [
  { maxLongEdge: 1920, minKbps: 2500 },
  { maxLongEdge: 1280, minKbps: 1200 },
  { maxLongEdge: 854, minKbps: 600 },
  { maxLongEdge: 640, minKbps: 300 },
  { maxLongEdge: 426, minKbps: 150 },
];

export function defaultTargetBytes(): number {
  return Math.floor(UPLOAD_MAX_BYTES * TARGET_SAFETY_RATIO);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sanitizeDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 1;
  return durationSec;
}

function toEven(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function containerOverhead(durationSec: number): number {
  return Math.floor(durationSec * CONTAINER_OVERHEAD_BYTES_PER_SEC);
}

export interface AudioRenderPlan {
  audioKbps: number;
  estimatedBytes: number;
  fitsBudget: boolean;
}

export interface VideoRenderPlan {
  videoKbps: number;
  audioKbps: number;
  /** Output frame size after the auto downscale step (never upscales). */
  maxWidth: number;
  maxHeight: number;
  /** Framerate cap; sources above this are reduced to save bitrate. */
  maxFps: number;
  estimatedBytes: number;
  fitsBudget: boolean;
}

/**
 * Audio-only plan (music / voice posts): spend the budget on bitrate,
 * clamped to sensible mp3 bounds.
 */
export function computeAudioPlan(durationSec: number, targetBytes = defaultTargetBytes()): AudioRenderPlan {
  const duration = sanitizeDuration(durationSec);
  const overhead = containerOverhead(duration);
  const usableBytes = Math.max(targetBytes - overhead, 1);
  const kbps = Math.floor(clamp((usableBytes * 8 * 0.9) / duration / 1000, MIN_AUDIO_KBPS, MAX_AUDIO_KBPS));
  const estimatedBytes = Math.floor(((kbps * 1000) / 8) * duration) + overhead;
  return {
    audioKbps: kbps,
    estimatedBytes,
    fitsBudget: estimatedBytes <= targetBytes,
  };
}

function pickFrameSize(width: number, height: number, videoKbps: number): { maxWidth: number; maxHeight: number } {
  let maxLongEdge = RESOLUTION_LADDER[RESOLUTION_LADDER.length - 1].maxLongEdge;
  for (const rung of RESOLUTION_LADDER) {
    if (videoKbps >= rung.minKbps) {
      maxLongEdge = rung.maxLongEdge;
      break;
    }
  }
  const longEdge = Math.max(width, height);
  const scale = Math.min(1, maxLongEdge / longEdge);
  return {
    maxWidth: toEven(width * scale),
    maxHeight: toEven(height * scale),
  };
}

function videoEstimateBytes(videoKbps: number, audioKbps: number, duration: number): number {
  return Math.floor(((videoKbps + audioKbps) * 1000 * duration) / 8) + containerOverhead(duration);
}

/**
 * Video plan: reserve an audio lane (128kbps, dropped to 64kbps when that is
 * the only way to fit), give the rest to video, then walk the resolution
 * ladder down until the bitrate is defensible for that size. When even the
 * floor settings cannot fit (very long clips), `fitsBudget` is false and the
 * UI should suggest trimming.
 */
export function computeVideoPlan(options: {
  durationSec: number;
  width: number;
  height: number;
  targetBytes?: number;
}): VideoRenderPlan {
  const duration = sanitizeDuration(options.durationSec);
  const targetBytes = options.targetBytes ?? defaultTargetBytes();
  const width = Math.max(2, Math.floor(options.width));
  const height = Math.max(2, Math.floor(options.height));
  const overhead = containerOverhead(duration);

  const planAtAudio = (audioKbps: number): number => {
    const usableBytes = Math.max(targetBytes - overhead - (audioKbps * 1000 * duration) / 8, 0);
    const rawVideoKbps = Math.floor((usableBytes * 8) / duration / 1000);
    return clamp(rawVideoKbps, MIN_VIDEO_KBPS, MAX_VIDEO_KBPS);
  };

  let audioKbps = DEFAULT_VIDEO_AUDIO_KBPS;
  let videoKbps = planAtAudio(audioKbps);
  if (videoEstimateBytes(videoKbps, audioKbps, duration) > targetBytes) {
    audioKbps = LOW_VIDEO_AUDIO_KBPS;
    videoKbps = planAtAudio(audioKbps);
  }

  const { maxWidth, maxHeight } = pickFrameSize(width, height, videoKbps);
  const estimatedBytes = videoEstimateBytes(videoKbps, audioKbps, duration);

  return {
    videoKbps,
    audioKbps,
    maxWidth,
    maxHeight,
    maxFps: 30,
    estimatedBytes,
    fitsBudget: estimatedBytes <= targetBytes,
  };
}

/**
 * One retry step after a real encode overshot the budget: drop the video
 * bitrate 40% and step down one resolution rung. Returns null at the floor
 * (caller should surface an error instead of looping forever).
 */
export function tightenVideoPlan(plan: VideoRenderPlan): VideoRenderPlan | null {
  const atFloor = plan.videoKbps <= MIN_VIDEO_KBPS && plan.maxHeight <= 426 && plan.maxWidth <= 426;
  if (atFloor) return null;

  const nextKbps = Math.max(Math.floor(plan.videoKbps * 0.6), MIN_VIDEO_KBPS);
  let nextLongEdge = Math.max(plan.maxWidth, plan.maxHeight);
  for (const rung of RESOLUTION_LADDER) {
    if (rung.maxLongEdge < nextLongEdge) {
      nextLongEdge = rung.maxLongEdge;
      break;
    }
  }

  const longEdge = Math.max(plan.maxWidth, plan.maxHeight);
  const scale = nextLongEdge < longEdge ? nextLongEdge / longEdge : 1;
  const maxWidth = toEven(plan.maxWidth * scale);
  const maxHeight = toEven(plan.maxHeight * scale);

  if (nextKbps === plan.videoKbps && maxWidth === plan.maxWidth && maxHeight === plan.maxHeight) {
    return null;
  }

  const ratio = plan.videoKbps > 0 ? nextKbps / plan.videoKbps : 1;
  const estimatedBytes = Math.min(
    Math.floor(plan.estimatedBytes * ratio * scale * scale) + containerOverhead(1),
    plan.estimatedBytes,
  );
  return {
    ...plan,
    videoKbps: nextKbps,
    maxWidth,
    maxHeight,
    estimatedBytes,
    fitsBudget: estimatedBytes <= defaultTargetBytes(),
  };
}

export function fitsWithinBudget(bytes: number, targetBytes = defaultTargetBytes()): boolean {
  return bytes <= targetBytes;
}

export const IMAGE_EXPORT_BOUNDS = {
  maxQuality: IMAGE_JPEG_MAX_QUALITY,
  minQuality: IMAGE_JPEG_MIN_QUALITY,
} as const;
