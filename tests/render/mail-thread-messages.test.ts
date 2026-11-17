import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Message {
  id: string;
  subject: string;
}

function createMessage(message: Message): HTMLElement {
  const card = document.createElement('article');
  card.className = 'mail-message';
  card.dataset.id = message.id;
  card.textContent = message.subject;
  return card;
}

describe('mail/thread-messages', () => {
  it('reuses keyed messages when a thread refreshes', () => {
    const root = document.createElement('div');
    const messages = signal<Message[]>([
      { id: 'm1', subject: 'First' },
      { id: 'm2', subject: 'Second' },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => messages(),
        (message) => message.id,
        (message) => {
          const value = message();
          const card = createMessage(value);
          return legacy(card, () => disposed.push(value.id));
        },
      ),
    );

    const first = root.querySelector<HTMLElement>('[data-id="m1"]');
    const second = root.querySelector<HTMLElement>('[data-id="m2"]');
    assert.ok(first);
    assert.ok(second);

    messages.set([
      { id: 'm1', subject: 'First' },
      { id: 'm2', subject: 'Second' },
      { id: 'm3', subject: 'Third' },
    ]);
    flushEffects();
    assert.equal(root.querySelector('[data-id="m1"]'), first);
    assert.equal(root.querySelector('[data-id="m2"]'), second);
    assert.equal(root.querySelector('[data-id="m3"]')?.textContent, 'Third');

    messages.set([{ id: 'm1', subject: 'First' }]);
    flushEffects();
    assert.deepEqual(disposed.sort(), ['m2', 'm3']);
    assert.equal(root.querySelector('[data-id="m1"]'), first);
  });
});
