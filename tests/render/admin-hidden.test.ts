import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface HiddenPost {
  id: string;
  text: string;
}

function createRow(post: HiddenPost): HTMLElement {
  const row = document.createElement('div');
  row.className = 'admin-hidden-row';
  row.dataset.id = post.id;
  row.textContent = post.text;
  return row;
}

describe('admin/hidden-list', () => {
  it('keeps remaining hidden posts when one is restored', () => {
    const root = document.createElement('div');
    const posts = signal<HiddenPost[]>([
      { id: 'p1', text: 'one' },
      { id: 'p2', text: 'two' },
      { id: 'p3', text: 'three' },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => posts(),
        (post) => post.id,
        (post) => {
          const value = post();
          return legacy(createRow(value), () => disposed.push(value.id));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-id="p1"]');
    const third = root.querySelector<HTMLElement>('[data-id="p3"]');
    assert.ok(first);
    assert.ok(third);

    // Unhide p2.
    posts.set(posts().filter((post) => post.id !== 'p2'));
    flushEffects();

    assert.equal(root.querySelector('[data-id="p1"]'), first);
    assert.equal(root.querySelector('[data-id="p3"]'), third);
    assert.equal(root.querySelector('[data-id="p2"]'), null);
    assert.deepEqual(disposed, ['p2']);
  });
});
