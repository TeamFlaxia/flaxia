import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sameStudioFileHistoryState } from '../src/lib/editor/studio-edit-history.ts';

describe('Studio edit history state comparison', () => {
  it('treats the same immutable assets and edits as unchanged', () => {
    const file = new File(['before'], 'scene.js', { type: 'text/javascript' });
    assert.equal(
      sameStudioFileHistoryState(
        { files: [file], activeIndex: 0, clips: [{ start: 1 }] },
        { files: [file], activeIndex: 0, clips: [{ start: 1 }] },
      ),
      true,
    );
  });

  it('records replacing a project file even when its name and size match', () => {
    const before = new File(['left'], 'scene.js', { type: 'text/javascript' });
    const after = new File(['rght'], 'scene.js', { type: 'text/javascript' });
    assert.equal(
      sameStudioFileHistoryState({ files: [before], activeIndex: 0 }, { files: [after], activeIndex: 0 }),
      false,
    );
  });

  it('tracks imported or removed assets and the active asset selection', () => {
    const first = new File(['one'], 'one.png');
    const second = new File(['two'], 'two.png');
    assert.equal(
      sameStudioFileHistoryState({ files: [first], activeIndex: 0 }, { files: [first, second], activeIndex: 0 }),
      false,
    );
    assert.equal(
      sameStudioFileHistoryState({ files: [first], activeIndex: 0 }, { files: [first], activeIndex: -1 }),
      false,
    );
  });

  it('tracks timeline edits by value', () => {
    const file = new File(['one'], 'one.wav');
    assert.equal(
      sameStudioFileHistoryState(
        { files: [file], activeIndex: 0, clips: [{ start: 1 }] },
        { files: [file], activeIndex: 0, clips: [{ start: 2 }] },
      ),
      false,
    );
  });
});
