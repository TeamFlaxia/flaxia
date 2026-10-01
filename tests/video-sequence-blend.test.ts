import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
