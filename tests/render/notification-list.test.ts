import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Row {
  id: string;
  read: boolean;
}

function createRoot(): HTMLElement {
  return document.createElement('div');
}

function createRow(row: Row): HTMLElement {
  const element = document.createElement('div');
  element.className = `notification-row ${row.read ? 'read' : 'unread'}`;
  element.dataset.id = row.id;
  if (!row.read) {
    const dot = document.createElement('span');
    dot.className = 'notification-dot';
    element.appendChild(dot);
  }
  // Mirrors NotificationsPage.destroy(): the engine must call this on removal
  // and on unmount instead of relying on DOM removal alone.
  return element;
}

function markAllRead(root: HTMLElement): void {
  for (const row of root.querySelectorAll('.notification-row')) {
    row.classList.remove('unread');
    row.classList.add('read');
    row.querySelector('.notification-dot')?.remove();
  }
}

describe('render/notification-list', () => {
  it('keeps keyed notification rows when the list grows', () => {
    const root = createRoot();
    const rows = signal<Row[]>([
      { id: 'n1', read: false },
      { id: 'n2', read: true },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => rows(),
        (row) => row.id,
        (row) => {
          const value = row();
          const element = createRow(value);
          return legacy(element, () => disposed.push(value.id));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-id="n1"]');
    const second = root.querySelector<HTMLElement>('[data-id="n2"]');
    assert.ok(first);
    assert.ok(second);

    rows.set([...rows(), { id: 'n3', read: false }]);
    flushEffects();

    assert.equal(root.querySelector<HTMLElement>('[data-id="n1"]'), first);
    assert.equal(root.querySelector<HTMLElement>('[data-id="n2"]'), second);
    assert.equal(root.querySelectorAll('.notification-row').length, 3);

    // Mark-all-read is a DOM mutation over the same keyed rows; it must not
    // force a rebuild or detach the rows.
    markAllRead(root);
    assert.equal(root.querySelector<HTMLElement>('[data-id="n1"]'), first);
    assert.equal(root.querySelectorAll('.notification-dot').length, 0);
  });

  it('disposes removed and unmounted rows through the legacy adapter', () => {
    const root = createRoot();
    const rows = signal<Row[]>([
      { id: 'n1', read: false },
      { id: 'n2', read: false },
    ]);
    const disposed: string[] = [];

    const mounted = mount(root, () =>
      each(
        () => rows(),
        (row) => row.id,
        (row) => {
          const value = row();
          const element = createRow(value);
          return legacy(element, () => disposed.push(value.id));
        },
      ),
    );

    rows.set([{ id: 'n1', read: false }]);
    flushEffects();
    assert.deepEqual(disposed, ['n2']);

    mounted.dispose();
    assert.deepEqual(disposed.sort(), ['n1', 'n2']);
    assert.equal(root.querySelector('.notification-row'), null);
  });
});
