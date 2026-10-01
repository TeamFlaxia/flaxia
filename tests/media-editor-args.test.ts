import assert from 'node:assert';
import { describe, it } from 'node:test';
import { buildAudioArgs, defaultAudioEditState } from '../src/lib/editor/audio-editor.ts';
import {
  type AudioTimelineClip,
  audibleAudioTimelineClips,
  audioClipEqSettings,
  audioClipGainAutomation,
  audioClipGainEnvelope,
  audioClipSpeed,
  audioClipTimelineDuration,
  audioTrackMixSettings,
  soloAudioTimelineClip,
  splitAudioClipGainEnvelope,
} from '../src/lib/editor/audio-mixer.ts';
import {
  buildGifEditArgs,
  defaultImageEditState,
  getOutputSize,
  type ImageEditState,
} from '../src/lib/editor/image-editor.ts';
import { computeVideoPlan } from '../src/lib/editor/render-preset.ts';
import {
  buildVideoArgs,
  defaultVideoEditState,
  resolveOutputSize,
  type VideoMeta,
} from '../src/lib/editor/video-editor.ts';
import {
  videoClipAudioFadeFilters,
  videoClipColorFilters,
  videoClipFadeFilters,
  videoClipOpacityAt,
} from '../src/lib/editor/video-sequence.ts';

describe('audio solo preview', () => {
  it('moves only the selected clip to time zero and preserves its trims and mix controls', () => {
    const clip: AudioTimelineClip = {
      id: 'audio-1',
      fileIndex: 2,
      track: 3,
      start: 12.5,
      sourceStart: 1.25,
      sourceEnd: 8.75,
      speed: 1.5,
      gain: 0.6,
      fadeIn: 0.4,
      fadeOut: 1.2,
      pan: -0.3,
      muted: true,
    };
    assert.deepEqual(soloAudioTimelineClip(clip), {
      ...clip,
      start: 0,
      muted: false,
      trackMuted: false,
      trackSolo: false,
    });
    assert.equal(clip.start, 12.5);
    assert.equal(clip.muted, true);
  });
});

describe('audio track mute and solo', () => {
  const clip = (id: string, track: number, settings: Partial<AudioTimelineClip> = {}): AudioTimelineClip => ({
    id,
    fileIndex: 0,
    track,
    start: 0,
    sourceStart: 0,
    sourceEnd: 5,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    pan: 0,
    muted: false,
    ...settings,
  });

  it('mutes whole tracks and restricts playback to soloed tracks', () => {
    const clips = [
      clip('muted-track', 0, { trackMuted: true }),
      clip('solo-track', 1, { trackSolo: true }),
      clip('other-track', 2),
      clip('muted-clip-on-solo', 1, { trackSolo: true, muted: true }),
    ];
    assert.deepEqual(
      audibleAudioTimelineClips(clips).map(({ id }) => id),
      ['solo-track'],
    );
  });

  it('plays every unmuted track when no track is soloed', () => {
    const clips = [clip('first', 0), clip('second', 1), clip('muted', 2, { trackMuted: true })];
    assert.deepEqual(
      audibleAudioTimelineClips(clips).map(({ id }) => id),
      ['first', 'second'],
    );
  });
});

describe('audio track mixer controls', () => {
  it('defaults track gain and pan to unity and center, and clamps saved values', () => {
    assert.deepEqual(audioTrackMixSettings({}), { gain: 1, pan: 0 });
    assert.deepEqual(audioTrackMixSettings({ trackGain: 3, trackPan: -2 }), { gain: 2, pan: -1 });
    assert.deepEqual(audioTrackMixSettings({ trackGain: Number.NaN, trackPan: Number.POSITIVE_INFINITY }), {
      gain: 1,
      pan: 0,
    });
  });
});

describe('audio clip playback speed', () => {
  it('changes placed duration while preserving the trimmed source range', () => {
    const clip = { sourceStart: 2, sourceEnd: 10, speed: 2 };
    assert.equal(audioClipSpeed(clip), 2);
    assert.equal(audioClipTimelineDuration(clip), 4);
    assert.equal(audioClipSpeed({ speed: 0.1 }), 0.5);
    assert.equal(audioClipTimelineDuration({ sourceStart: 0, sourceEnd: 6, speed: 0.5 }), 12);
    assert.equal(audioClipSpeed({ speed: Number.NaN }), 1);
  });
});

describe('audio clip EQ', () => {
  it('defaults missing controls to flat EQ and clamps saved values', () => {
    assert.deepEqual(audioClipEqSettings({}), { lowEqDb: 0, midEqDb: 0, highEqDb: 0 });
    assert.deepEqual(audioClipEqSettings({ lowEqDb: -24, midEqDb: 4, highEqDb: Number.NaN }), {
      lowEqDb: -18,
      midEqDb: 4,
      highEqDb: 0,
    });
    assert.deepEqual(audioClipEqSettings({ lowEqDb: 22, midEqDb: -20, highEqDb: 18 }), {
      lowEqDb: 18,
      midEqDb: -18,
      highEqDb: 18,
    });
  });
});

describe('audio clip volume automation', () => {
  it('defaults to unity and clamps envelope points to the 0–200% range', () => {
    assert.deepEqual(audioClipGainEnvelope({}), { start: 1, middle: 1, end: 1 });
    assert.deepEqual(audioClipGainEnvelope({ gainEnvelope: { start: -1, middle: 0.75, end: 3 } }), {
      start: 0,
      middle: 0.75,
      end: 2,
    });
  });

  it('creates a smooth three-point gain curve and multiplies it with the fades', () => {
    const clip = {
      gain: 0.5,
      fadeIn: 2,
      fadeOut: 2,
      gainEnvelope: { start: 0, middle: 1, end: 0.5 },
    };
    assert.deepEqual(audioClipGainAutomation(clip, 10), [
      { time: 0, gain: 0 },
      { time: 2, gain: 0.2 },
      { time: 5, gain: 0.5 },
      { time: 8, gain: 0.35 },
      { time: 10, gain: 0 },
    ]);
  });

  it('keeps the original gain curve continuous across an audio split', () => {
    const split = splitAudioClipGainEnvelope({ gainEnvelope: { start: 0.5, middle: 1.5, end: 0.25 } }, 0.3);
    assert.deepEqual(split.left, { start: 0.5, middle: 0.8, end: 1.1 });
    assert.equal(split.right.start, 1.1);
    assert.ok(Math.abs(split.right.middle - 1.125) < 1e-12);
    assert.equal(split.right.end, 0.25);
    assert.equal(split.left.end, split.right.start);
  });
});

describe('video sequence fades', () => {
  it('builds bounded timeline fade filters', () => {
    assert.deepEqual(videoClipFadeFilters(8, 1.25, 2), ['fade=t=in:st=0:d=1.250', 'fade=t=out:st=6.000:d=2.000']);
    assert.deepEqual(videoClipFadeFilters(4, 8, -1), ['fade=t=in:st=0:d=4.000']);
    assert.deepEqual(videoClipFadeFilters(0), []);
  });

  it('builds matching source-audio fades on the post-speed timeline', () => {
    assert.deepEqual(videoClipAudioFadeFilters(8, 1.25, 2), [
      'afade=t=in:st=0:d=1.250',
      'afade=t=out:st=6.000:d=2.000',
    ]);
    assert.deepEqual(videoClipAudioFadeFilters(4, 8, -1), ['afade=t=in:st=0:d=4.000']);
    assert.deepEqual(videoClipAudioFadeFilters(0), []);
  });

  it('computes the preview opacity for both clip edges', () => {
    assert.equal(videoClipOpacityAt(0.5, 8, 1, 2), 0.5);
    assert.equal(videoClipOpacityAt(7, 8, 1, 2), 0.5);
    assert.equal(videoClipOpacityAt(3, 8, 1, 2), 1);
  });
});

describe('video clip image adjustments', () => {
  it('omits hue and blur filters at their neutral values', () => {
    assert.deepEqual(videoClipColorFilters({}), ['eq=brightness=0.000:contrast=1.000:saturation=1.000']);
  });

  it('clamps color controls and emits FFmpeg hue and blur filters', () => {
    assert.deepEqual(videoClipColorFilters({ brightness: 250, contrast: -10, hueDeg: 90, blurPx: 0.1 }), [
      'eq=brightness=1.000:contrast=0.000:saturation=1.000',
      'hue=h=1.571',
      'gblur=sigma=0.5',
    ]);
  });
});

describe('image-editor getOutputSize', () => {
  const base = (): ImageEditState => defaultImageEditState();

  it('keeps source size by default', () => {
    assert.deepEqual(getOutputSize(800, 600, base()), { width: 800, height: 600 });
  });

  it('swaps dimensions on 90° rotation', () => {
    const state = { ...base(), rotation: 90 as const };
    assert.deepEqual(getOutputSize(800, 600, state), { width: 600, height: 800 });
  });

  it('applies crop in rotated space', () => {
    const state: ImageEditState = { ...base(), crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } };
    assert.deepEqual(getOutputSize(800, 600, state), { width: 400, height: 300 });
  });

  it('caps the long edge without upscaling', () => {
    const capped: ImageEditState = { ...base(), maxLongEdge: 400 };
    assert.deepEqual(getOutputSize(1600, 900, capped), { width: 400, height: 225 });
    assert.deepEqual(getOutputSize(300, 200, capped), { width: 300, height: 200 });
  });
});

describe('image-editor buildGifEditArgs', () => {
  it('emits flips, rotation, crop, scale and eq in pipeline order', () => {
    const state: ImageEditState = {
      rotation: 90,
      flipX: true,
      flipY: false,
      crop: { x: 0, y: 0, w: 0.5, h: 0.5 },
      brightness: 110,
      contrast: 90,
      maxLongEdge: 100,
      autoLongEdge: false,
    };
    // 400x200 source → rotated 200x400 → crop half → 100x200 → cap long edge 100
    const args = buildGifEditArgs(400, 200, state, 'in.gif', 'out.gif');
    const vf = args[args.indexOf('-vf') + 1];
    assert.ok(vf.startsWith('hflip,'), vf);
    assert.ok(vf.includes('transpose=1'), vf);
    assert.ok(vf.includes('crop='), vf);
    assert.ok(vf.includes('scale='), vf);
    assert.ok(vf.includes('eq=brightness=0.100:contrast=0.900'), vf);
    assert.equal(args[args.length - 1], 'out.gif');
    assert.ok(args.includes('-loop'));
  });

  it('skips -vf when the state is neutral', () => {
    const args = buildGifEditArgs(400, 200, defaultImageEditState(), 'in.gif', 'out.gif');
    assert.ok(!args.includes('-vf'));
  });
});

describe('audio-editor buildAudioArgs', () => {
  it('trims with input seek and encodes mp3 at the plan bitrate', () => {
    const state = { ...defaultAudioEditState(60), start: 1.5, end: 12.25 };
    const args = buildAudioArgs(state, 192, 'in.wav', 'out.mp3');
    assert.deepEqual(args.slice(0, 6), ['-ss', '1.500', '-t', '10.750', '-i', 'in.wav']);
    assert.ok(args.includes('-b:a'));
    assert.equal(args[args.indexOf('-b:a') + 1], '192k');
    assert.equal(args[args.length - 3], '-f');
    assert.equal(args[args.length - 2], 'mp3');
    assert.equal(args[args.length - 1], 'out.mp3');
    assert.ok(!args.includes('-af'));
  });

  it('adds a volume filter for non-default loudness', () => {
    const state = { ...defaultAudioEditState(30), volume: 150 };
    const args = buildAudioArgs(state, 128, 'in.mp3', 'out.mp3');
    assert.ok(args.includes('-af'));
    assert.equal(args[args.indexOf('-af') + 1], 'volume=1.500');
  });

  it('mutes to silence at volume 0', () => {
    const state = { ...defaultAudioEditState(30), muted: true };
    const args = buildAudioArgs(state, 128, 'in.mp3', 'out.mp3');
    assert.equal(args[args.indexOf('-af') + 1], 'volume=0.000');
  });
});

describe('video-editor args and sizing', () => {
  const meta: VideoMeta = { duration: 30, width: 1920, height: 1080 };

  it('resolveOutputSize honors source/auto/numeric choices without upscaling', () => {
    const plan = computeVideoPlan({ durationSec: 30, width: meta.width, height: meta.height });
    assert.deepEqual(resolveOutputSize(meta, plan, 'source'), { width: 1920, height: 1080 });
    const auto = resolveOutputSize(meta, plan, 'auto');
    assert.equal(auto.width % 2, 0);
    assert.ok(auto.width <= 1920 && auto.height <= 1080);
    assert.deepEqual(resolveOutputSize(meta, plan, 720), { width: 720, height: 404 }); // even floor
    assert.deepEqual(resolveOutputSize({ duration: 10, width: 640, height: 360 }, plan, 1080), {
      width: 640,
      height: 360,
    });
  });

  it('omits scale when output matches source, adds eq when adjusting', () => {
    const state = { ...defaultVideoEditState(meta), start: 2, end: 10, brightness: 120 };
    const args = buildVideoArgs({
      state,
      videoKbps: 2500,
      audioKbps: 128,
      width: 1920,
      height: 1080,
      sourceWidth: 1920,
      sourceHeight: 1080,
      hasAudioFilter: false,
      inputName: 'in.mp4',
      outputName: 'out.mp4',
    });
    const vfIdx = args.indexOf('-vf');
    assert.ok(vfIdx > 0);
    assert.ok(!args[vfIdx + 1].includes('scale='), args[vfIdx + 1]);
    assert.ok(args[vfIdx + 1].includes('eq=brightness=0.200:contrast=1.000'));
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('+faststart'));
    assert.deepEqual(args.slice(0, 5), ['-ss', '2.000', '-t', '8.000', '-i']);
  });

  it('drops the audio track when muted and keeps aac otherwise', () => {
    const muted = { ...defaultVideoEditState(meta), muted: true };
    const mutedArgs = buildVideoArgs({
      state: muted,
      videoKbps: 1000,
      audioKbps: 128,
      width: 1920,
      height: 1080,
      sourceWidth: 1920,
      sourceHeight: 1080,
      hasAudioFilter: false,
      inputName: 'in.mp4',
      outputName: 'out.mp4',
    });
    assert.ok(mutedArgs.includes('-an'));
    assert.ok(!mutedArgs.includes('-c:a'));

    const loud = { ...defaultVideoEditState(meta), volume: 50 };
    const loudArgs = buildVideoArgs({
      state: loud,
      videoKbps: 1000,
      audioKbps: 128,
      width: 1280,
      height: 720,
      sourceWidth: 1920,
      sourceHeight: 1080,
      hasAudioFilter: true,
      inputName: 'in.mp4',
      outputName: 'out.mp4',
    });
    assert.ok(loudArgs.includes('-c:a'));
    assert.equal(loudArgs[loudArgs.indexOf('-af') + 1], 'volume=0.500');
    assert.ok(loudArgs[loudArgs.indexOf('-vf') + 1].startsWith('scale=1280:720'));
  });
});
