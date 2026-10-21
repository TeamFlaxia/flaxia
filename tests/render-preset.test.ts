import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeAudioPlan,
  computeVideoPlan,
  defaultTargetBytes,
  fitsWithinBudget,
  tightenVideoPlan,
  UPLOAD_MAX_BYTES,
} from '../src/lib/editor/render-preset.ts';

describe('render-preset', () => {
  it('target stays under the 25MB upload cap', () => {
    const target = defaultTargetBytes();
    assert.ok(target < UPLOAD_MAX_BYTES);
    assert.ok(target > UPLOAD_MAX_BYTES * 0.9);
  });

  it('audio plan clamps short clips to 320kbps', () => {
    const plan = computeAudioPlan(10, 20 * 1024 * 1024);
    assert.equal(plan.audioKbps, 320);
    assert.ok(plan.estimatedBytes <= 20 * 1024 * 1024);
    assert.equal(plan.fitsBudget, true);
  });

  it('audio plan clamps long clips to 64kbps', () => {
    const plan = computeAudioPlan(60 * 60, defaultTargetBytes());
    assert.equal(plan.audioKbps, 64);
  });

  it('audio plan scales bitrate with duration', () => {
    const tenMinutes = computeAudioPlan(600);
    const twentyMinutes = computeAudioPlan(1200);
    assert.ok(tenMinutes.audioKbps > twentyMinutes.audioKbps);
    assert.ok(tenMinutes.audioKbps >= 64 && tenMinutes.audioKbps <= 320);
  });

  it('video plan keeps small clips at source resolution', () => {
    const plan = computeVideoPlan({ durationSec: 5, width: 1280, height: 720 });
    assert.equal(plan.maxWidth, 1280);
    assert.equal(plan.maxHeight, 720);
    assert.ok(plan.videoKbps >= 150);
    assert.ok(fitsWithinBudget(plan.estimatedBytes));
    assert.equal(plan.fitsBudget, true);
  });

  it('video plan downgrades resolution for long durations', () => {
    const short = computeVideoPlan({ durationSec: 30, width: 1920, height: 1080 });
    const long = computeVideoPlan({ durationSec: 30 * 60, width: 1920, height: 1080 });
    assert.equal(short.maxHeight, 1080);
    assert.ok(long.maxHeight < short.maxHeight);
    // 30 minutes cannot fit inside 25MB at any acceptable quality — the plan
    // reports that honestly so the UI can suggest trimming.
    assert.equal(long.fitsBudget, false);
    assert.ok(short.fitsBudget);
  });

  it('video plan never upscales tiny sources', () => {
    const plan = computeVideoPlan({ durationSec: 60, width: 320, height: 240 });
    assert.equal(plan.maxWidth, 320);
    assert.equal(plan.maxHeight, 240);
  });

  it('video plan floors bitrate at 150kbps', () => {
    const plan = computeVideoPlan({ durationSec: 60 * 60, width: 640, height: 360 });
    assert.ok(plan.videoKbps >= 150);
  });

  it('tightenVideoPlan reduces bitrate and returns null at the floor', () => {
    const plan = computeVideoPlan({ durationSec: 600, width: 1920, height: 1080 });
    const tightened = tightenVideoPlan(plan);
    assert.ok(tightened);
    assert.ok(tightened.videoKbps < plan.videoKbps || tightened.maxHeight < plan.maxHeight);

    const floor = { ...plan, videoKbps: 150, maxHeight: 426, maxWidth: 240 };
    assert.equal(tightenVideoPlan(floor), null);
  });

  it('handles degenerate durations without NaN', () => {
    const audio = computeAudioPlan(0);
    const video = computeVideoPlan({ durationSec: Number.NaN, width: 100, height: 100 });
    assert.ok(Number.isFinite(audio.audioKbps));
    assert.ok(Number.isFinite(video.videoKbps));
    assert.ok(Number.isFinite(video.estimatedBytes));
  });
});
