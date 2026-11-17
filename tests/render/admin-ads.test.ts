import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Ad {
  id: string;
  title: string;
  active: number;
}

function adKey(ad: Ad): string {
  return `${ad.id}:${ad.active ? '1' : '0'}`;
}

function createRow(ad: Ad): HTMLElement {
  const row = document.createElement('div');
  row.className = 'admin-ad-row';
  row.dataset.key = adKey(ad);
  row.textContent = `${ad.title}:${ad.active ? 'active' : 'inactive'}`;
  return row;
}

describe('admin/ads-list', () => {
  it('recreates only the toggled ad and keeps the rest', () => {
    const root = document.createElement('div');
    const ads = signal<Ad[]>([
      { id: 'a1', title: 'First', active: 1 },
      { id: 'a2', title: 'Second', active: 1 },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => ads(),
        adKey,
        (ad) => {
          const value = ad();
          return legacy(createRow(value), () => disposed.push(adKey(value)));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-key="a1:1"]');
    const second = root.querySelector<HTMLElement>('[data-key="a2:1"]');
    assert.ok(first);
    assert.ok(second);

    ads.set([
      { id: 'a1', title: 'First', active: 0 },
      { id: 'a2', title: 'Second', active: 1 },
    ]);
    flushEffects();

    assert.equal(root.querySelector('[data-key="a1:1"]'), null);
    assert.equal(root.querySelector('[data-key="a2:1"]'), second);
    assert.equal(root.querySelector('[data-key="a1:0"]')?.textContent, 'First:inactive');
    assert.deepEqual(disposed, ['a1:1']);

    ads.set([{ id: 'a1', title: 'First', active: 0 }]);
    flushEffects();
    assert.equal(root.querySelector('[data-key="a2:1"]'), null);
    assert.ok(disposed.includes('a2:1'));
  });
});
