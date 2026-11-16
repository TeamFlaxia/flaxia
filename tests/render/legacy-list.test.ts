import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Item {
  id: string;
}

function createRoot(): HTMLElement {
  return document.createElement('div');
}

describe('render/legacy-list', () => {
  it('appends keyed legacy components without recreating existing ones', () => {
    const root = createRoot();
    const items = signal<Item[]>([{ id: 'a' }, { id: 'b' }]);
    const nodes = new Map<string, HTMLElement>();
    const disposed: string[] = [];

    const mounted = mount(root, () =>
      each(
        () => items(),
        (item) => item.id,
        (item) => {
          const value = item();
          const element = document.createElement('div');
          element.className = 'legacy-card';
          element.dataset.id = value.id;
          nodes.set(value.id, element);
          return legacy(element, () => {
            disposed.push(value.id);
          });
        },
      ),
    );

    const firstA = nodes.get('a');
    const firstB = nodes.get('b');
    assert.ok(firstA);
    assert.ok(firstB);
    assert.deepEqual(
      [...root.querySelectorAll<HTMLElement>('.legacy-card')].map((element) => element.dataset.id),
      ['a', 'b'],
    );

    items.set([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    flushEffects();

    assert.equal(root.querySelector<HTMLElement>('.legacy-card[data-id="a"]'), firstA);
    assert.equal(root.querySelector<HTMLElement>('.legacy-card[data-id="b"]'), firstB);
    assert.deepEqual(
      [...root.querySelectorAll<HTMLElement>('.legacy-card')].map((element) => element.dataset.id),
      ['a', 'b', 'c'],
    );

    mounted.dispose();
    assert.deepEqual(disposed.sort(), ['a', 'b', 'c']);
    assert.equal(root.querySelector('.legacy-card'), null);
  });

  it('disposes only the legacy components removed from the list', () => {
    const root = createRoot();
    const items = signal<Item[]>([{ id: 'a' }, { id: 'b' }]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => items(),
        (item) => item.id,
        (item) => {
          const value = item();
          const element = document.createElement('div');
          element.dataset.id = value.id;
          return legacy(element, () => {
            disposed.push(value.id);
          });
        },
      ),
    );

    items.set([{ id: 'a' }]);
    flushEffects();

    assert.deepEqual(disposed, ['b']);
    assert.equal(root.querySelector('[data-id="a"]') !== null, true);
  });
});
