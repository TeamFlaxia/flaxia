import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  audioClipGainAutomation,
  audioClipGainEnvelopeAt,
  audioClipGainEnvelopePoints,
  moveAudioClipGainEnvelopePoint,
  removeAudioClipGainEnvelopePoint,
  setAudioClipGainEnvelopePoint,
  splitAudioClipGainEnvelope,
} from '../src/lib/editor/audio-mixer.ts';

describe('audio clip gain automation', () => {
  it('applies overlapping fades independently at both ends of a clip', () => {
    const automation = audioClipGainAutomation({ gain: 1, fadeIn: 4, fadeOut: 4 }, 6);

    assert.deepEqual(automation, [
      { time: 0, gain: 0 },
      { time: 2, gain: 0.5 },
      { time: 3, gain: 0.5625 },
      { time: 4, gain: 0.5 },
      { time: 6, gain: 0 },
    ]);
  });

  it('clamps each fade to the full clip duration', () => {
    const automation = audioClipGainAutomation({ gain: 1, fadeIn: 10, fadeOut: 10 }, 3);

    assert.deepEqual(automation, [
      { time: 0, gain: 0 },
      { time: 1.5, gain: 0.25 },
      { time: 3, gain: 0 },
    ]);
  });

  it('interpolates arbitrary control points in the rendered mix automation', () => {
    const clip = {
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      gainEnvelope: {
        start: 1,
        middle: 1,
        end: 1,
        points: [
          { position: 0, gain: 1 },
          { position: 0.25, gain: 0 },
          { position: 0.75, gain: 2 },
          { position: 1, gain: 1 },
        ],
      },
    };
    assert.equal(audioClipGainEnvelopeAt(clip, 0.125), 0.5);
    assert.equal(audioClipGainEnvelopeAt(clip, 0.5), 1);
    assert.equal(audioClipGainEnvelopeAt(clip, 0.875), 1.5);
    assert.deepEqual(audioClipGainAutomation(clip, 4), [
      { time: 0, gain: 1 },
      { time: 1, gain: 0 },
      { time: 2, gain: 1 },
      { time: 3, gain: 2 },
      { time: 4, gain: 1 },
    ]);
  });

  it('adds, moves, and removes intermediate automation points', () => {
    const clip: {
      gainEnvelope?: { start: number; middle: number; end: number; points?: { position: number; gain: number }[] };
    } = {};
    clip.gainEnvelope = setAudioClipGainEnvelopePoint(clip, 0.3, 0.25);
    assert.equal(audioClipGainEnvelopePoints(clip).length, 4);
    clip.gainEnvelope = moveAudioClipGainEnvelopePoint(clip, 1, 0.4, 1.75);
    assert.deepEqual(audioClipGainEnvelopePoints(clip)[1], { position: 0.4, gain: 1.75 });
    clip.gainEnvelope = removeAudioClipGainEnvelopePoint(clip, 1);
    assert.deepEqual(
      audioClipGainEnvelopePoints(clip).map((point) => point.position),
      [0, 0.5, 1],
    );
  });

  it('preserves intermediate points and their curve when splitting a clip', () => {
    const clip = {
      gainEnvelope: {
        start: 1,
        middle: 0.75,
        end: 1.5,
        points: [
          { position: 0, gain: 1 },
          { position: 0.2, gain: 0.5 },
          { position: 0.6, gain: 2 },
          { position: 1, gain: 1.5 },
        ],
      },
    };
    const split = splitAudioClipGainEnvelope(clip, 0.4);
    assert.equal(split.left.points?.length, 3);
    assert.equal(split.right.points?.length, 3);
    assert.ok(Math.abs(audioClipGainEnvelopeAt({ gainEnvelope: split.left }, 1) - 1.25) < 1e-12);
    assert.ok(Math.abs(audioClipGainEnvelopeAt({ gainEnvelope: split.right }, 0) - 1.25) < 1e-12);
    assert.equal(audioClipGainEnvelopeAt({ gainEnvelope: split.left }, 0.5), 0.5);
    assert.equal(audioClipGainEnvelopeAt({ gainEnvelope: split.right }, 1 / 3), 2);
  });
});
