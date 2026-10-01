export interface AudioTimelineClip {
  id: string;
  fileIndex: number;
  track: number;
  start: number;
  sourceStart: number;
  sourceEnd: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  pan: number;
  muted: boolean;
}

/** Copy one clip for isolated audition while preserving its trims and mix controls. */
export function soloAudioTimelineClip(clip: AudioTimelineClip): AudioTimelineClip {
  return { ...clip, start: 0, muted: false };
}

function audioContextConstructor(): typeof AudioContext {
  const prefixed = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Context = window.AudioContext || prefixed.webkitAudioContext;
  if (!Context) throw new Error('Web Audio is not available in this browser');
  return Context;
}

function encodeWav(buffer: AudioBuffer): Blob {
  const channels = 2;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const output = new ArrayBuffer(44 + frames * channels * bytesPerSample);
  const view = new DataView(output);
  const write = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, output.byteLength - 8, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  write(36, 'data');
  view.setUint32(40, frames * channels * bytesPerSample, true);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    const l = Math.max(-1, Math.min(1, left[frame]));
    const r = Math.max(-1, Math.min(1, right[frame]));
    view.setInt16(offset, l < 0 ? l * 32768 : l * 32767, true);
    view.setInt16(offset + 2, r < 0 ? r * 32768 : r * 32767, true);
    offset += 4;
  }
  return new Blob([output], { type: 'audio/wav' });
}

/** Mix placed audio clips to a stereo PCM WAV in the browser. */
export async function mixAudioTimeline(
  files: File[],
  clips: AudioTimelineClip[],
  name = 'flaxia-mix.wav',
): Promise<File> {
  const active = clips.filter((clip) => !clip.muted && clip.sourceEnd > clip.sourceStart);
  if (active.length === 0) throw new Error('Add an audible clip to the audio tracks first');
  const duration = Math.max(...active.map((clip) => clip.start + clip.sourceEnd - clip.sourceStart));
  if (!Number.isFinite(duration) || duration <= 0 || duration > 240) {
    throw new Error('Audio mixdowns must be between 0 and 4 minutes');
  }

  const Context = audioContextConstructor();
  const decoder = new Context();
  try {
    const decoded = new Map<number, AudioBuffer>();
    for (const clip of active) {
      const file = files[clip.fileIndex];
      if (!file || !file.type.startsWith('audio/')) continue;
      if (!decoded.has(clip.fileIndex))
        decoded.set(clip.fileIndex, await decoder.decodeAudioData(await file.arrayBuffer()));
    }
    if (decoded.size === 0) throw new Error('No playable audio files are on the timeline');

    const sampleRate = 22050;
    const frames = Math.ceil(duration * sampleRate);
    const OfflineContext = window.OfflineAudioContext;
    if (!OfflineContext) throw new Error('Offline audio rendering is not available in this browser');
    const offline = new OfflineContext(2, frames, sampleRate);
    for (const clip of active) {
      const buffer = decoded.get(clip.fileIndex);
      if (!buffer) continue;
      const sourceStart = Math.max(0, Math.min(clip.sourceStart, buffer.duration));
      const sourceEnd = Math.max(sourceStart, Math.min(clip.sourceEnd, buffer.duration));
      if (sourceEnd <= sourceStart) continue;
      const source = offline.createBufferSource();
      source.buffer = buffer;
      const gain = offline.createGain();
      const clipDuration = Math.min(sourceEnd - sourceStart, Math.max(0, duration - Math.max(0, clip.start)));
      const startAt = Math.max(0, clip.start);
      const fadeIn = Math.min(clipDuration, Math.max(0, clip.fadeIn));
      const fadeOut = Math.min(Math.max(0, clipDuration - fadeIn), Math.max(0, clip.fadeOut));
      const targetGain = Math.max(0, Math.min(4, clip.gain));
      gain.gain.setValueAtTime(fadeIn > 0 ? 0 : targetGain, startAt);
      if (fadeIn > 0) gain.gain.linearRampToValueAtTime(targetGain, startAt + fadeIn);
      if (fadeOut > 0) {
        gain.gain.setValueAtTime(targetGain, startAt + clipDuration - fadeOut);
        gain.gain.linearRampToValueAtTime(0, startAt + clipDuration);
      }
      source.connect(gain);
      const panner = offline.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, clip.pan));
      gain.connect(panner);
      panner.connect(offline.destination);
      source.start(startAt, sourceStart, clipDuration);
    }
    const mixed = await offline.startRendering();
    return new File([encodeWav(mixed)], name, { type: 'audio/wav' });
  } finally {
    await decoder.close().catch(() => undefined);
  }
}
