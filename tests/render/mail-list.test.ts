import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface MailRow {
  id: string;
  subject: string;
  unread: boolean;
}

function createRow(thread: MailRow): HTMLElement {
  const row = document.createElement('div');
  row.className = `mail-thread-row${thread.unread ? ' mail-thread-row--unread' : ''}`;
  row.dataset.threadId = thread.id;
  row.textContent = thread.subject;
  if (thread.unread) {
    const dot = document.createElement('span');
    dot.className = 'mail-unread-dot';
    row.appendChild(dot);
  }
  return row;
}

describe('mail/list', () => {
  it('reuses keyed mail rows when the folder or search changes', () => {
    const root = document.createElement('div');
    const rows = signal<MailRow[]>([
      { id: 'm1', subject: 'First', unread: true },
      { id: 'm2', subject: 'Second', unread: false },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => rows(),
        (thread) => thread.id,
        (thread) => {
          const value = thread();
          const row = createRow(value);
          return legacy(row, () => disposed.push(value.id));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-thread-id="m1"]');
    const second = root.querySelector<HTMLElement>('[data-thread-id="m2"]');
    assert.ok(first);
    assert.ok(second);

    // Search narrows the list; the matching row survives.
    rows.set([
      { id: 'm1', subject: 'First', unread: true },
      { id: 'm3', subject: 'Third', unread: true },
    ]);
    flushEffects();
    assert.equal(root.querySelector('[data-thread-id="m1"]'), first);
    assert.equal(root.querySelector('[data-thread-id="m2"]'), null);
    assert.deepEqual(disposed, ['m2']);

    // Read state is mutated in place on the surviving row.
    first.classList.remove('mail-thread-row--unread');
    first.querySelector('.mail-unread-dot')?.remove();
    assert.equal(first.classList.contains('mail-thread-row--unread'), false);
    assert.equal(first.querySelector('.mail-unread-dot'), null);
    assert.equal(root.querySelector('[data-thread-id="m1"]'), first);
  });
});
