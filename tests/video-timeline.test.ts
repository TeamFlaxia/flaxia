import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rippleOverlappingVideoClips } from '../src/lib/editor/video-timeline.ts';

function clip(id: string, start: number, sourceEnd: number, speed = 1) {
  return { id, fileIndex: 0, start, sourceStart: 0, sourceEnd, speed };
}

describe('video timeline ripple layout', () => {
  it('pushes overlapping clips forward while preserving their sorted order', () => {
    const clips = [clip('first', 0, 5), clip('second', 3, 4), clip('third', 6, 2)];
    assert.equal(rippleOverlappingVideoClips(clips), true);
    assert.deepEqual(
      clips.map((item) => [item.id, item.start]),
      [
        ['first', 0],
        ['second', 5],
        ['third', 9],
      ],
    );
  });

  it('keeps intentional gaps and does not report an unchanged layout', () => {
    const clips = [clip('first', 0, 3), clip('second', 8, 2)];
    assert.equal(rippleOverlappingVideoClips(clips), false);
    assert.deepEqual(
      clips.map((item) => item.start),
      [0, 8],
    );
  });

  it('uses playback speed when calculating the next clip boundary', () => {
    const clips = [clip('fast', 0, 4, 2), clip('next', 1, 2)];
    assert.equal(rippleOverlappingVideoClips(clips), true);
    assert.deepEqual(
      clips.map((item) => item.start),
      [0, 2],
    );
  });

  it('overlaps adjacent clips by the selected transition duration', () => {
    const clips = [{ ...clip('first', 0, 4), transitionOut: 1 }, clip('second', 4, 3)];
    assert.equal(rippleOverlappingVideoClips(clips), true);
    assert.deepEqual(
      clips.map((item) => [item.id, item.start]),
      [
        ['first', 0],
        ['second', 3],
      ],
    );
    assert.equal(rippleOverlappingVideoClips(clips), false);
  });

  it('limits a transition to half the duration of the shorter clip', () => {
    const clips = [{ ...clip('first', 0, 8), transitionOut: 2 }, clip('short', 8, 1)];
    rippleOverlappingVideoClips(clips);
    assert.deepEqual(
      clips.map((item) => item.start),
      [0, 7.5],
    );
  });

  it('repairs invalid positions without producing a negative timeline start', () => {
    const clips = [clip('first', -3, 2), clip('second', Number.NaN, 1)];
    assert.equal(rippleOverlappingVideoClips(clips), true);
    assert.deepEqual(
      clips.map((item) => item.start),
      [0, 2],
    );
  });
});
