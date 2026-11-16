import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, html, mount, signal } from '../../src/lib/render/index.ts';

interface Row {
  id: string;
  label: string;
}

function createRoot(): HTMLElement {
  return document.createElement('div');
}

function labels(root: Element): string[] {
  return [...root.querySelectorAll('li')].map((item) => item.textContent ?? '');
}

describe('render/each', () => {
  it('renders a keyed list', () => {
    const root = createRoot();
    const rows = signal<Row[]>([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ]);

    mount(
      root,
      () =>
        html`<ul>
          ${each(
            () => rows(),
            (row) => row.id,
            (row) => html`<li>${() => row().label}</li>`,
          )}
        </ul>`,
    );

    assert.deepEqual(labels(root), ['A', 'B', 'C']);
  });

  it('moves existing nodes instead of recreating them on reorder', () => {
    const root = createRoot();
    const rows = signal<Row[]>([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ]);

    mount(
      root,
      () =>
        html`<ul>
          ${each(
            () => rows(),
            (row) => row.id,
            (row) => html`<li data-id=${() => row().id}>${() => row().label}</li>`,
          )}
        </ul>`,
    );

    const before = [...root.querySelectorAll('li')] as HTMLElement[];
    const nodeA = before[0];
    const nodeB = before[1];
    const nodeC = before[2];

    rows.set([
      { id: 'c', label: 'C' },
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);
    flushEffects();

    const after = [...root.querySelectorAll('li')] as HTMLElement[];
    assert.deepEqual(labels(root), ['C', 'A', 'B']);
    assert.equal(after[0], nodeC);
    assert.equal(after[1], nodeA);
    assert.equal(after[2], nodeB);
  });

  it('inserts and removes items while preserving the rest', () => {
    const root = createRoot();
    const rows = signal<Row[]>([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);

    mount(
      root,
      () =>
        html`<ul>
          ${each(
            () => rows(),
            (row) => row.id,
            (row) => html`<li>${() => row().label}</li>`,
          )}
        </ul>`,
    );

    const nodeA = root.querySelector('li');
    assert.ok(nodeA);

    rows.set([
      { id: 'a', label: 'A' },
      { id: 'x', label: 'X' },
      { id: 'b', label: 'B' },
    ]);
    flushEffects();
    assert.deepEqual(labels(root), ['A', 'X', 'B']);
    assert.equal(root.querySelector('li'), nodeA);

    rows.set([
      { id: 'a', label: 'A' },
      { id: 'x', label: 'X' },
    ]);
    flushEffects();
    assert.deepEqual(labels(root), ['A', 'X']);
    assert.equal(root.querySelector('li'), nodeA);
  });

  it('keeps an iframe mounted when a keyed card moves', () => {
    const root = createRoot();
    const rows = signal<Row[]>([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);

    mount(
      root,
      () =>
        html`<div>
          ${each(
            () => rows(),
            (row) => row.id,
            (row) =>
              html`<article data-id=${row().id}>
                <iframe title=${row().id}></iframe>
                <span>${() => row().label}</span>
              </article>`,
          )}
        </div>`,
    );

    const frames = [...root.querySelectorAll('iframe')];
    assert.equal(frames.length, 2);

    rows.set([
      { id: 'b', label: 'B' },
      { id: 'a', label: 'A' },
    ]);
    flushEffects();

    const after = [...root.querySelectorAll('iframe')];
    assert.equal(after[0], frames[1]);
    assert.equal(after[1], frames[0]);
  });

  it('updates an item in place through its accessor', () => {
    const root = createRoot();
    const rows = signal<Row[]>([{ id: 'a', label: 'A' }]);

    mount(
      root,
      () =>
        html`<ul>
          ${each(
            () => rows(),
            (row) => row.id,
            (row) => html`<li>${() => row().label}</li>`,
          )}
        </ul>`,
    );

    const item = root.querySelector('li');
    assert.ok(item);

    rows.set([{ id: 'a', label: 'A updated' }]);
    flushEffects();

    assert.equal(root.querySelector('li'), item);
    assert.equal(item.textContent, 'A updated');
  });

  it('updates index accessors without recreating items', () => {
    const root = createRoot();
    const rows = signal<Row[]>([
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);

    mount(
      root,
      () =>
        html`<ul>
          ${each(
            () => rows(),
            (row) => row.id,
            (row, index) => html`<li>${() => `${index()}:${row().label}`}</li>`,
          )}
        </ul>`,
    );

    const itemA = root.querySelector('li');
    assert.ok(itemA);
    assert.equal(itemA.textContent, '0:A');

    rows.set([
      { id: 'b', label: 'B' },
      { id: 'a', label: 'A' },
    ]);
    flushEffects();

    const after = [...root.querySelectorAll('li')];
    assert.equal(after[1], itemA);
    assert.deepEqual(labels(root), ['0:B', '1:A']);
  });

  it('reports duplicate keys', () => {
    const root = createRoot();
    const rows = signal<Row[]>([
      { id: 'a', label: 'A' },
      { id: 'a', label: 'B' },
    ]);

    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      mount(
        root,
        () =>
          html`<ul>
            ${each(
              () => rows(),
              (row) => row.id,
              (row) => html`<li>${() => row().label}</li>`,
            )}
          </ul>`,
      );
    } finally {
      console.error = original;
    }

    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /duplicate key/);
  });
});
