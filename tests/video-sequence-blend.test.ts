import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { videoOverlayBlendMode } from '../src/lib/editor/video-sequence.ts';

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
