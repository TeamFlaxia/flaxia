import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { audioClipGainAutomation } from '../src/lib/editor/audio-mixer.ts';

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
});
