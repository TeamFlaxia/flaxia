import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Title {
  id: string;
  name: string;
}

type TitleEntry = { kind: 'title'; title: Title } | { kind: 'empty' } | { kind: 'error' };

interface Stamp {
  id: string;
  name: string;
}

type StampEntry = { kind: 'stamp'; stamp: Stamp } | { kind: 'add' } | { kind: 'error' };

describe('settings/lists', () => {
  it('reuses keyed title rows and replaces empty/error states', () => {
    const root = document.createElement('div');
    const titles = signal<TitleEntry[]>([{ kind: 'empty' }]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => titles(),
        (entry) => (entry.kind === 'title' ? entry.title.id : entry.kind),
        (entry) => {
          const value = entry();
          if (value.kind !== 'title') {
            const node = document.createElement('p');
            node.dataset.kind = value.kind;
            return node;
          }
          const node = document.createElement('div');
          node.dataset.id = value.title.id;
          node.textContent = value.title.name;
          return legacy(node, () => disposed.push(value.title.id));
        },
      ),
    );

    assert.ok(root.querySelector('[data-kind="empty"]'));

    titles.set([
      { kind: 'title', title: { id: 't1', name: 'First' } },
      { kind: 'title', title: { id: 't2', name: 'Second' } },
    ]);
    flushEffects();
    const first = root.querySelector<HTMLElement>('[data-id="t1"]');
    assert.ok(first);
    assert.equal(root.querySelector('[data-kind="empty"]'), null);

    titles.set([
      { kind: 'title', title: { id: 't1', name: 'First' } },
      { kind: 'title', title: { id: 't3', name: 'Third' } },
    ]);
    flushEffects();
    assert.equal(root.querySelector('[data-id="t1"]'), first);
    assert.deepEqual(disposed, ['t2']);

    titles.set([{ kind: 'error' }]);
    flushEffects();
    assert.ok(root.querySelector('[data-kind="error"]'));
    assert.equal(root.querySelector('[data-id="t1"]'), null);
  });

  it('keeps stamp cards and the add card keyed', () => {
    const root = document.createElement('div');
    const stamps = signal<StampEntry[]>([{ kind: 'stamp', stamp: { id: 's1', name: 'nya' } }, { kind: 'add' }]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => stamps(),
        (entry) => (entry.kind === 'stamp' ? entry.stamp.id : entry.kind),
        (entry) => {
          const value = entry();
          if (value.kind !== 'stamp') {
            const add = document.createElement('div');
            add.dataset.kind = value.kind;
            return add;
          }
          const card = document.createElement('div');
          card.dataset.id = value.stamp.id;
          card.textContent = value.stamp.name;
          return legacy(card, () => disposed.push(value.stamp.id));
        },
      ),
    );

    const stamp = root.querySelector<HTMLElement>('[data-id="s1"]');
    const add = root.querySelector<HTMLElement>('[data-kind="add"]');
    assert.ok(stamp);
    assert.ok(add);

    stamps.set([
      { kind: 'stamp', stamp: { id: 's1', name: 'nya' } },
      { kind: 'stamp', stamp: { id: 's2', name: 'wow' } },
      { kind: 'add' },
    ]);
    flushEffects();
    assert.equal(root.querySelector('[data-id="s1"]'), stamp);
    assert.equal(root.querySelector('[data-kind="add"]'), add);

    stamps.set([{ kind: 'stamp', stamp: { id: 's1', name: 'nya' } }, { kind: 'add' }]);
    flushEffects();
    assert.deepEqual(disposed, ['s2']);
  });
});

interface BillingRow {
  key: string;
  left: string;
  right: string;
}

describe('settings/display-and-billing', () => {
  it('renders static choice options in signal order', () => {
    const root = document.createElement('div');
    const options = [
      { value: 'light', labelKey: 'Light' },
      { value: 'dark', labelKey: 'Dark' },
    ];

    mount(root, () =>
      each(
        () => options,
        (option) => option.value,
        (option) => {
          const label = document.createElement('label');
          label.dataset.value = option().value;
          label.textContent = option().labelKey;
          return legacy(label);
        },
      ),
    );

    assert.deepEqual(
      [...root.querySelectorAll<HTMLElement>('label')].map((element) => element.dataset.value),
      ['light', 'dark'],
    );
  });

  it('reuses billing rows across refreshes and disposes dropped ones', () => {
    const root = document.createElement('div');
    const rows = signal<BillingRow[]>([
      { key: '2026-01|Flaxia+|300 JPY', left: '2026-01 · Flaxia+', right: '300 JPY · Paid' },
      { key: '2026-02|Flaxia+|300 JPY', left: '2026-02 · Flaxia+', right: '300 JPY · Paid' },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => rows(),
        (row) => row.key,
        (row) => {
          const value = row();
          const element = document.createElement('div');
          element.dataset.key = value.key;
          return legacy(element, () => disposed.push(value.key));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-key="2026-01|Flaxia+|300 JPY"]');
    assert.ok(first);

    rows.set([
      { key: '2026-01|Flaxia+|300 JPY', left: '2026-01 · Flaxia+', right: '300 JPY · Paid' },
      { key: '2026-03|Flaxia+|300 JPY', left: '2026-03 · Flaxia+', right: '300 JPY · Paid' },
    ]);
    flushEffects();

    assert.equal(root.querySelector('[data-key="2026-01|Flaxia+|300 JPY"]'), first);
    assert.equal(root.querySelector('[data-key="2026-02|Flaxia+|300 JPY"]'), null);
    assert.deepEqual(disposed, ['2026-02|Flaxia+|300 JPY']);
  });
});
