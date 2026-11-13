import assert from 'node:assert';
import { describe, it } from 'node:test';
import { pickTopTagsWithNone } from '../functions/lib/crowd.ts';

describe('pickTopTagsWithNone (Top3 + none)', () => {
  it('adds 3 tags when none is outside Top3', () => {
    const picked = pickTopTagsWithNone({ game: 0.5, music: 0.3, food: 0.2, none: 0.05 });
    assert.deepEqual(picked, ['game', 'music', 'food']);
  });

  it('adds 2 tags when none ranks 3rd', () => {
    const picked = pickTopTagsWithNone({ game: 0.5, music: 0.3, none: 0.2, food: 0.1 });
    assert.deepEqual(picked, ['game', 'music']);
  });

  it('adds 1 tag when none ranks 2nd', () => {
    const picked = pickTopTagsWithNone({ game: 0.5, none: 0.3, music: 0.2, food: 0.1 });
    assert.deepEqual(picked, ['game']);
  });

  it('adds nothing when none ranks 1st', () => {
    const picked = pickTopTagsWithNone({ none: 0.7, game: 0.2, music: 0.1, food: 0.05 });
    assert.deepEqual(picked, []);
  });

  it('ignores malformed probabilities (hostile node output)', () => {
    const picked = pickTopTagsWithNone({ game: 0.5, bad: NaN as unknown as number, music: 0.2 } as Record<
      string,
      number
    >);
    assert.deepEqual(picked, ['game', 'music']);
    assert.deepEqual(pickTopTagsWithNone({}), []);
  });

  it('never emits none as a tag', () => {
    for (const picked of [
      pickTopTagsWithNone({ a: 0.9, none: 0.05, b: 0.04, c: 0.03 }),
      pickTopTagsWithNone({ none: 0.1, a: 0.05, b: 0.04, c: 0.03 }),
    ]) {
      assert.ok(!picked.includes('none'));
    }
  });
});
