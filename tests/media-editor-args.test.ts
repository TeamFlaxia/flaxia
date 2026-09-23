import assert from 'node:assert';
import { describe, it } from 'node:test';
import { buildAudioArgs, defaultAudioEditState } from '../src/lib/editor/audio-editor.ts';
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
