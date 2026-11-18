import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Reply {
  id: string;
  label: string;
}

function createReply(reply: Reply): HTMLElement {
  const row = document.createElement('div');
  row.className = 'reply-node';
  row.dataset.id = reply.id;
  row.textContent = reply.label;
  return row;
}

describe('thread/replies-list', () => {
  it('keeps flat replies keyed when a new reply is appended', () => {
    const root = document.createElement('div');
    const replies = signal<Reply[]>([
      { id: 'r1', label: 'first' },
      { id: 'r2', label: 'second' },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => replies(),
        (reply) => reply.id,
        (reply) => {
          const value = reply();
          const element = createReply(value);
          return legacy(element, () => disposed.push(value.id));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-id="r1"]');
    const second = root.querySelector<HTMLElement>('[data-id="r2"]');
    assert.ok(first);
    assert.ok(second);

    replies.set([...replies(), { id: 'r3', label: 'third' }]);
    flushEffects();
    assert.equal(root.querySelector('[data-id="r1"]'), first);
    assert.equal(root.querySelector('[data-id="r2"]'), second);
    assert.equal(root.querySelector('[data-id="r3"]')?.textContent, 'third');

    replies.set([{ id: 'r1', label: 'first' }]);
    flushEffects();
    assert.deepEqual(disposed.sort(), ['r2', 'r3']);
    assert.equal(root.querySelector('[data-id="r1"]'), first);
  });
});
