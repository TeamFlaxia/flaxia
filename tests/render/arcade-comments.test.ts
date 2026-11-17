import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Comment {
  id: string;
  label: string;
}

function createComment(comment: Comment): HTMLElement {
  const row = document.createElement('div');
  row.className = 'comment-row';
  row.dataset.id = comment.id;
  row.textContent = comment.label;
  return row;
}

describe('arcade/comments-list', () => {
  it('reuses keyed comments when the thread refreshes', () => {
    const root = document.createElement('div');
    const comments = signal<Comment[]>([
      { id: 'c1', label: 'first' },
      { id: 'c2', label: 'second' },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => comments(),
        (comment) => comment.id,
        (comment) => {
          const value = comment();
          const node = createComment(value);
          return legacy(node, () => disposed.push(value.id));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-id="c1"]');
    const second = root.querySelector<HTMLElement>('[data-id="c2"]');
    assert.ok(first);
    assert.ok(second);

    comments.set([
      { id: 'c1', label: 'first' },
      { id: 'c2', label: 'second' },
      { id: 'c3', label: 'third' },
    ]);
    flushEffects();

    assert.equal(root.querySelector('[data-id="c1"]'), first);
    assert.equal(root.querySelector('[data-id="c2"]'), second);
    assert.equal(root.querySelector('[data-id="c3"]')?.textContent, 'third');

    comments.set([{ id: 'c1', label: 'first' }]);
    flushEffects();
    assert.deepEqual(disposed.sort(), ['c2', 'c3']);
    assert.equal(root.querySelector('[data-id="c1"]'), first);
  });
});
