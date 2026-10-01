export interface AudioTimelineClip {
  id: string;
  fileIndex: number;
  track: number;
  start: number;
  sourceStart: number;
  sourceEnd: number;
  speed?: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  pan: number;
  lowEqDb?: number;
  midEqDb?: number;
  highEqDb?: number;
  gainEnvelope?: AudioGainEnvelope;
  trackMuted?: boolean;
  trackSolo?: boolean;
  trackGain?: number;
  trackPan?: number;
  muted: boolean;
}

/** Normalize source playback speed; changing it also changes pitch. */
export function audioClipSpeed(clip: Pick<AudioTimelineClip, 'speed'>): number {
  return typeof clip.speed === 'number' && Number.isFinite(clip.speed) ? Math.max(0.5, Math.min(2, clip.speed)) : 1;
}

/** Return the placed timeline duration for a trimmed source clip. */
export function audioClipTimelineDuration(
  clip: Pick<AudioTimelineClip, 'sourceStart' | 'sourceEnd' | 'speed'>,
): number {
  return Math.max(0, clip.sourceEnd - clip.sourceStart) / audioClipSpeed(clip);
}

/** Normalize the shared mixer controls stored on each clip in a track. */
export function audioTrackMixSettings(clip: Pick<AudioTimelineClip, 'trackGain' | 'trackPan'>): {
  gain: number;
  pan: number;
} {
  return {
    gain:
      typeof clip.trackGain === 'number' && Number.isFinite(clip.trackGain)
        ? Math.max(0, Math.min(2, clip.trackGain))
        : 1,
    pan:
      typeof clip.trackPan === 'number' && Number.isFinite(clip.trackPan)
        ? Math.max(-1, Math.min(1, clip.trackPan))
        : 0,
  };
}

/** Apply clip mute plus track mute/solo state consistently to preview and export. */
export function audibleAudioTimelineClips(clips: AudioTimelineClip[]): AudioTimelineClip[] {
  const soloedTracks = new Set(clips.filter((clip) => clip.trackSolo).map((clip) => clip.track));
  return clips.filter(
    (clip) =>
      !clip.muted &&
      !clip.trackMuted &&
      (soloedTracks.size === 0 || soloedTracks.has(clip.track)) &&
      clip.sourceEnd > clip.sourceStart,
  );
}

export interface AudioGainEnvelope {
  start: number;
  middle: number;
  end: number;
}

/** Normalize the three editable clip-volume control points (0–200%). */
export function audioClipGainEnvelope(clip: { gainEnvelope?: AudioGainEnvelope }): Required<AudioGainEnvelope> {
  const normalize = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 1;
  return {
    start: normalize(clip.gainEnvelope?.start),
    middle: normalize(clip.gainEnvelope?.middle),
    end: normalize(clip.gainEnvelope?.end),
  };
}

/** Interpolate the saved three-point gain curve at a clip position from 0 to 1. */
export function audioClipGainEnvelopeAt(clip: { gainEnvelope?: AudioGainEnvelope }, position: number): number {
  const envelope = audioClipGainEnvelope(clip);
  const fraction = Math.max(0, Math.min(1, Number.isFinite(position) ? position : 0));
  return fraction <= 0.5
    ? envelope.start + (envelope.middle - envelope.start) * fraction * 2
    : envelope.middle + (envelope.end - envelope.middle) * (fraction - 0.5) * 2;
}

/** Preserve a clip's piecewise-linear volume curve when splitting it. */
export function splitAudioClipGainEnvelope(
  clip: { gainEnvelope?: AudioGainEnvelope },
  position: number,
): { left: Required<AudioGainEnvelope>; right: Required<AudioGainEnvelope> } {
  const split = Math.max(0, Math.min(1, Number.isFinite(position) ? position : 0));
  return {
    left: {
      start: audioClipGainEnvelopeAt(clip, 0),
      middle: audioClipGainEnvelopeAt(clip, split / 2),
      end: audioClipGainEnvelopeAt(clip, split),
    },
    right: {
      start: audioClipGainEnvelopeAt(clip, split),
      middle: audioClipGainEnvelopeAt(clip, split + (1 - split) / 2),
      end: audioClipGainEnvelopeAt(clip, 1),
    },
  };
}

/** Compute piecewise-linear gain samples combined with the clip's fades. */
export function audioClipGainAutomation(
  clip: Pick<AudioTimelineClip, 'gain' | 'fadeIn' | 'fadeOut' | 'gainEnvelope'>,
  duration: number,
): Array<{ time: number; gain: number }> {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const envelope = audioClipGainEnvelope(clip);
  const fadeIn = Math.min(duration, Math.max(0, Number.isFinite(clip.fadeIn) ? clip.fadeIn : 0));
  const fadeOut = Math.min(duration, Math.max(0, Number.isFinite(clip.fadeOut) ? clip.fadeOut : 0));
  const baseGain = Math.max(0, Math.min(4, Number.isFinite(clip.gain) ? clip.gain : 0));
  const middleTime = duration / 2;
  const gainAt = (time: number): number => {
    const fraction = Math.max(0, Math.min(1, time / duration));
    const envelopeGain = audioClipGainEnvelopeAt({ gainEnvelope: envelope }, fraction);
    const fadeInGain = fadeIn > 0 ? Math.min(1, time / fadeIn) : 1;
    const fadeOutGain = fadeOut > 0 ? Math.min(1, (duration - time) / fadeOut) : 1;
    return baseGain * envelopeGain * fadeInGain * fadeOutGain;
  };
  const times = new Set([0, middleTime, duration]);
  if (fadeIn > 0) times.add(fadeIn);
  if (fadeOut > 0) times.add(duration - fadeOut);
  return [...times].sort((left, right) => left - right).map((time) => ({ time, gain: gainAt(time) }));
}

export interface AudioEqSettings {
  lowEqDb?: number;
  midEqDb?: number;
  highEqDb?: number;
}

/** Clamp the saved three-band EQ controls to a useful, stable range. */
export function audioClipEqSettings(clip: AudioEqSettings): Required<AudioEqSettings> {
  const clamp = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(-18, Math.min(18, value)) : 0;
  return { lowEqDb: clamp(clip.lowEqDb), midEqDb: clamp(clip.midEqDb), highEqDb: clamp(clip.highEqDb) };
}

/** Copy one clip for isolated audition while preserving its trims and mix controls. */
export function soloAudioTimelineClip(clip: AudioTimelineClip): AudioTimelineClip {
  return { ...clip, start: 0, muted: false, trackMuted: false, trackSolo: false };
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
  const active = audibleAudioTimelineClips(clips);
  if (active.length === 0) throw new Error('Add an audible clip to the audio tracks first');
  const duration = Math.max(...active.map((clip) => clip.start + audioClipTimelineDuration(clip)));
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
      const speed = audioClipSpeed(clip);
      source.playbackRate.value = speed;
      const eq = audioClipEqSettings(clip);
      const lowEq = offline.createBiquadFilter();
      lowEq.type = 'lowshelf';
      lowEq.frequency.value = 120;
      lowEq.gain.value = eq.lowEqDb;
      const midEq = offline.createBiquadFilter();
      midEq.type = 'peaking';
      midEq.frequency.value = 1_000;
      midEq.Q.value = 0.9;
      midEq.gain.value = eq.midEqDb;
      const highEq = offline.createBiquadFilter();
      highEq.type = 'highshelf';
      highEq.frequency.value = 8_000;
      highEq.gain.value = eq.highEqDb;
      const gain = offline.createGain();
      const clipDuration = Math.min(
        audioClipTimelineDuration({ ...clip, sourceStart, sourceEnd }),
        Math.max(0, duration - Math.max(0, clip.start)),
      );
      const startAt = Math.max(0, clip.start);
      const fadeIn = Math.min(clipDuration, Math.max(0, clip.fadeIn));
      const fadeOut = Math.min(Math.max(0, clipDuration - fadeIn), Math.max(0, clip.fadeOut));
      const trackMix = audioTrackMixSettings(clip);
      const automation = audioClipGainAutomation(
        { ...clip, gain: clip.gain * trackMix.gain, fadeIn, fadeOut },
        clipDuration,
      );
      automation.forEach((point, index) => {
        const time = startAt + point.time;
        if (index === 0) gain.gain.setValueAtTime(point.gain, time);
        else gain.gain.linearRampToValueAtTime(point.gain, time);
      });
      source.connect(lowEq);
      lowEq.connect(midEq);
      midEq.connect(highEq);
      highEq.connect(gain);
      const panner = offline.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, clip.pan + trackMix.pan));
      gain.connect(panner);
      panner.connect(offline.destination);
      source.start(startAt, sourceStart, clipDuration * speed);
    }
    const mixed = await offline.startRendering();
    return new File([encodeWav(mixed)], name, { type: 'audio/wav' });
  } finally {
    await decoder.close().catch(() => undefined);
  }
}
