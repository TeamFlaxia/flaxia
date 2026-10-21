import { runFFmpeg } from './ffmpeg-client.ts';
import { computeVideoPlan, defaultTargetBytes, type VideoRenderPlan } from './render-preset.ts';

export type VideoResolutionChoice = 'auto' | 'source' | number;

export interface VideoEditState {
  start: number;
  end: number;
  /** Source duration in seconds. */
  duration: number;
  /** Percent, 100 = original loudness. */
  volume: number;
  muted: boolean;
  /** Percent, 100 = neutral (matches CSS filter semantics). */
  brightness: number;
  contrast: number;
  resolution: VideoResolutionChoice;
}

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
}

export function defaultVideoEditState(meta: VideoMeta): VideoEditState {
  return {
    start: 0,
    end: meta.duration,
    duration: meta.duration,
    volume: 100,
    muted: false,
    brightness: 100,
    contrast: 100,
    resolution: 'auto',
  };
}

export function isVideoStateDirty(state: VideoEditState): boolean {
  return (
    state.start > 0.01 ||
    state.end < state.duration - 0.01 ||
    state.volume !== 100 ||
    state.muted ||
    state.brightness !== 100 ||
    state.contrast !== 100 ||
    state.resolution !== 'auto'
  );
}

/** Probes duration and frame size via a throwaway video element. */
export function probeVideo(file: File): Promise<VideoMeta> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const meta: VideoMeta = {
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1,
        width: video.videoWidth || 640,
        height: video.videoHeight || 360,
      };
      cleanup();
      resolve(meta);
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('video probe failed'));
    };
    video.src = url;
  });
}

function fitLongEdge(width: number, height: number, cap: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= cap) return { width, height };
  const scale = cap / longEdge;
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
}

export function resolveOutputSize(
  meta: VideoMeta,
  plan: VideoRenderPlan,
  choice: VideoResolutionChoice,
): { width: number; height: number } {
  if (choice === 'source') return { width: meta.width, height: meta.height };
  if (typeof choice === 'number') return fitLongEdge(meta.width, meta.height, choice);
  return { width: plan.maxWidth, height: plan.maxHeight };
}

/** Budget plan for the current trim/resolution choice (drives the estimate UI). */
export function planForState(
  meta: VideoMeta,
  state: VideoEditState,
  targetBytes = defaultTargetBytes(),
): {
  plan: VideoRenderPlan;
  width: number;
  height: number;
} {
  const trimLength = Math.max(state.end - state.start, 0.05);
  const plan = computeVideoPlan({ durationSec: trimLength, width: meta.width, height: meta.height, targetBytes });
  const size = resolveOutputSize(meta, plan, state.resolution);
  return { plan, width: size.width, height: size.height };
}

export function buildVideoArgs(options: {
  state: VideoEditState;
  videoKbps: number;
  audioKbps: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  hasAudioFilter: boolean;
  inputName: string;
  outputName: string;
}): string[] {
  const { state, videoKbps, audioKbps, width, height, inputName, outputName } = options;
  const trimLength = Math.max(state.end - state.start, 0.05);
  const args = ['-ss', state.start.toFixed(3), '-t', trimLength.toFixed(3), '-i', inputName];

  const vf: string[] = [];
  if (width !== options.sourceWidth || height !== options.sourceHeight) {
    vf.push(`scale=${width}:${height}`);
  }
  if (state.brightness !== 100 || state.contrast !== 100) {
    const b = (state.brightness / 100 - 1).toFixed(3);
    const c = (state.contrast / 100).toFixed(3);
    vf.push(`eq=brightness=${b}:contrast=${c}`);
  }
  if (vf.length > 0) args.push('-vf', vf.join(','));

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-b:v',
    `${videoKbps}k`,
    '-maxrate',
    `${Math.floor(videoKbps * 1.5)}k`,
    '-bufsize',
    `${videoKbps * 2}k`,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
  );

  const volume = state.muted ? 0 : state.volume / 100;
  if (state.muted) {
    args.push('-an');
  } else {
    if (options.hasAudioFilter && volume !== 1) {
      args.push('-af', `volume=${volume.toFixed(3)}`);
    }
    args.push('-c:a', 'aac', '-b:a', `${audioKbps}k`);
  }

  args.push('-f', 'mp4', outputName);
  return args;
}

function safeBaseName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

function inputFsName(name: string): string {
  const ext = (name.toLowerCase().split('.').pop() || 'bin').replace(/[^a-z0-9]/g, '');
  return `input.${ext || 'bin'}`;
}

/**
 * Trims/filters the video into an mp4 (h264/aac). If the first encode fails
 * while a volume filter was applied (silent source with no audio track), it
 * retries once without the filter.
 */
export async function encodeVideoFile(
  file: File,
  meta: VideoMeta,
  state: VideoEditState,
  options: {
    onProgress?: (ratio: number) => void;
    targetBytes?: number;
    tighten?: (plan: VideoRenderPlan) => VideoRenderPlan | null;
    signal?: () => boolean;
    multithreaded?: boolean;
  } = {},
): Promise<File> {
  const targetBytes = options.targetBytes ?? defaultTargetBytes();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inputName = inputFsName(file.name);
  const outputName = 'output.mp4';

  let { plan, width, height } = planForState(meta, state, targetBytes);
  const volume = state.muted ? 0 : state.volume / 100;
  const wantsVolumeFilter = !state.muted && volume !== 1;

  const attempt = async (
    activePlan: VideoRenderPlan,
    outW: number,
    outH: number,
    withAudioFilter: boolean,
  ): Promise<Uint8Array> =>
    runFFmpeg({
      // writeFile transfers the buffer (detaching it), so each attempt gets
      // its own copy — retries would otherwise hit DataCloneError.
      inputs: [{ name: inputName, data: bytes.slice() }],
      args: buildVideoArgs({
        state,
        videoKbps: activePlan.videoKbps,
        audioKbps: activePlan.audioKbps,
        width: outW,
        height: outH,
        sourceWidth: meta.width,
        sourceHeight: meta.height,
        hasAudioFilter: withAudioFilter,
        inputName,
        outputName,
      }),
      outputName,
      onProgress: options.onProgress,
      signal: options.signal,
      multithreaded: options.multithreaded,
    });

  let data: Uint8Array;
  try {
    data = await attempt(plan, width, height, wantsVolumeFilter);
  } catch (error) {
    if (wantsVolumeFilter) {
      data = await attempt(plan, width, height, false);
    } else {
      throw error;
    }
  }

  if (data.byteLength > targetBytes && options.tighten) {
    const next = options.tighten(plan);
    if (next) {
      plan = next;
      const size = resolveOutputSize(meta, plan, state.resolution);
      width = size.width;
      height = size.height;
      try {
        data = await attempt(plan, width, height, wantsVolumeFilter);
      } catch {
        data = await attempt(plan, width, height, false);
      }
    }
  }

  if (data.byteLength > targetBytes) {
    throw new Error('output-too-large');
  }
  const base = safeBaseName(file.name) || 'video';
  return new File([data as BlobPart], `${base}.mp4`, { type: 'video/mp4' });
}
