import { runFFmpeg } from './ffmpeg-client.ts';
import { computeAudioPlan, defaultTargetBytes } from './render-preset.ts';

export interface AudioEditState {
  start: number;
  end: number;
  /** Percent, 100 = original loudness. */
  volume: number;
  muted: boolean;
}

export function defaultAudioEditState(duration: number): AudioEditState {
  return { start: 0, end: duration, volume: 100, muted: false };
}

export function isAudioStateDirty(state: AudioEditState, sourceDuration: number): boolean {
  return state.start > 0.01 || state.end < sourceDuration - 0.01 || state.volume !== 100 || state.muted;
}

export function buildAudioArgs(
  state: AudioEditState,
  audioKbps: number,
  inputName: string,
  outputName: string,
): string[] {
  const trimLength = Math.max(state.end - state.start, 0.05);
  const args = ['-ss', state.start.toFixed(3), '-t', trimLength.toFixed(3), '-i', inputName];
  const volume = state.muted ? 0 : state.volume / 100;
  if (volume !== 1) {
    args.push('-af', `volume=${volume.toFixed(3)}`);
  }
  args.push('-vn', '-ar', '44100', '-b:a', `${audioKbps}k`, '-f', 'mp3', outputName);
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

/** Re-encodes the trimmed/attenuated audio to mp3 within the byte budget. */
export async function encodeAudioFile(
  file: File,
  state: AudioEditState,
  options: {
    onProgress?: (ratio: number) => void;
    targetBytes?: number;
    signal?: () => boolean;
  } = {},
): Promise<File> {
  const targetBytes = options.targetBytes ?? defaultTargetBytes();
  const trimLength = Math.max(state.end - state.start, 0.05);
  const plan = computeAudioPlan(trimLength, targetBytes);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inputName = inputFsName(file.name);
  const outputName = 'output.mp3';

  const data = await runFFmpeg({
    inputs: [{ name: inputName, data: bytes }],
    args: buildAudioArgs(state, plan.audioKbps, inputName, outputName),
    outputName,
    onProgress: options.onProgress,
    signal: options.signal,
  });

  if (data.byteLength > targetBytes) {
    throw new Error('output-too-large');
  }
  const base = safeBaseName(file.name) || 'audio';
  return new File([data as BlobPart], `${base}.mp3`, { type: 'audio/mpeg' });
}
