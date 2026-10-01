import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildVideoSequenceJoinFilters,
  studioVideoFrameSize,
  studioVideoLayerPlacement,
  videoOverlayBlendMode,
} from '../src/lib/editor/video-sequence.ts';

describe('video sequence blend modes', () => {
  it('maps every image layer blend mode to the matching FFmpeg blend operation', () => {
    assert.deepEqual(
      [
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
      ].map((mode) => videoOverlayBlendMode(mode as Parameters<typeof videoOverlayBlendMode>[0])),
      [
        null,
        'multiply',
        'screen',
        'overlay',
        'darken',
        'lighten',
        'dodge',
        'burn',
        'hardlight',
        'softlight',
        'difference',
        'exclusion',
      ],
    );
  });
});

describe('video sequence canvas formats', () => {
  it('maps landscape, square, and portrait formats to social video dimensions', () => {
    assert.deepEqual(studioVideoFrameSize('landscape'), { width: 1280, height: 720 });
    assert.deepEqual(studioVideoFrameSize('square'), { width: 1080, height: 1080 });
    assert.deepEqual(studioVideoFrameSize('portrait'), { width: 720, height: 1280 });
  });

  it('centers the shared square layer canvas inside each video format', () => {
    assert.deepEqual(studioVideoLayerPlacement('landscape'), { scale: 2 / 3, offsetX: 280, offsetY: 0 });
    assert.deepEqual(studioVideoLayerPlacement('square'), { scale: 1, offsetX: 0, offsetY: 0 });
    assert.deepEqual(studioVideoLayerPlacement('portrait'), { scale: 2 / 3, offsetX: 0, offsetY: 280 });
  });
});

describe('video sequence joins', () => {
  it('passes a single clip through to the MP4 export labels', () => {
    assert.deepEqual(buildVideoSequenceJoinFilters([{ video: 'v0', audio: 'a0', start: 0, duration: 4 }]), {
      filters: ['[v0]null[outvbase]', '[a0]anull[outa]'],
      duration: 4,
    });
  });

  it('crossfades overlapping clips and mixes their source audio', () => {
    const result = buildVideoSequenceJoinFilters([
      { video: 'v0', audio: 'a0', start: 0, duration: 4 },
      { video: 'v1', audio: 'a1', start: 3, duration: 4 },
    ]);
    assert.deepEqual(result, {
      filters: [
        '[v0][v1]xfade=transition=fade:duration=1.000:offset=3.000[outvbase]',
        '[a0][a1]acrossfade=d=1.000:c1=tri:c2=tri[outa]',
      ],
      duration: 7,
    });
  });
});
