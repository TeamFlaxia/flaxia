import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imageLayerCanvasFilter, normalizeImageLayerAdjustments } from '../src/lib/editor/image-adjustments.ts';
import { isStudioImageBlendMode } from '../src/lib/editor/image-layer-canvas.ts';

describe('image layer adjustments', () => {
  it('defaults to neutral hue and blur while retaining the existing neutral color settings', () => {
    assert.deepEqual(normalizeImageLayerAdjustments({}), {
      brightness: 100,
      contrast: 100,
      saturation: 100,
      hueDeg: 0,
      blurPx: 0,
    });
    assert.equal(
      imageLayerCanvasFilter({}),
      'brightness(100%) contrast(100%) saturate(100%) hue-rotate(0deg) blur(0px)',
    );
  });

  it('clamps saved or imported adjustments to the image editor control ranges', () => {
    assert.deepEqual(
      normalizeImageLayerAdjustments({
        brightness: 250,
        contrast: -1,
        saturation: Number.NaN,
        hueDeg: -250,
        blurPx: 40,
      }),
      { brightness: 200, contrast: 0, saturation: 100, hueDeg: -180, blurPx: 30 },
    );
    assert.equal(
      imageLayerCanvasFilter({ brightness: 125, contrast: 90, saturation: 80, hueDeg: 30, blurPx: 2.5 }),
      'brightness(125%) contrast(90%) saturate(80%) hue-rotate(30deg) blur(2.5px)',
    );
  });
});

describe('image layer blend modes', () => {
  it('accepts the supported canvas blend modes and rejects unknown project data', () => {
    for (const mode of [
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
    ]) {
      assert.equal(isStudioImageBlendMode(mode), true, `${mode} should be supported`);
    }
    assert.equal(isStudioImageBlendMode('unsupported'), false);
    assert.equal(isStudioImageBlendMode(null), false);
  });
});
