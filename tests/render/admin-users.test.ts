import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface AdminUser {
  id: string;
  username: string;
  frozen: boolean;
}

function userKey(user: AdminUser): string {
  return `${user.id}:${user.frozen ? 'frozen' : 'active'}`;
}

function createRow(user: AdminUser): HTMLElement {
  const row = document.createElement('div');
  row.className = 'admin-user-row';
  row.dataset.key = userKey(user);
  row.textContent = `@${user.username}${user.frozen ? ' (frozen)' : ''}`;
  return row;
}

describe('admin/users-list', () => {
  it('reuses rows by id and rebuilds only the frozen state change', () => {
    const root = document.createElement('div');
    const users = signal<AdminUser[]>([
      { id: 'u1', username: 'alice', frozen: false },
      { id: 'u2', username: 'bob', frozen: false },
    ]);
    const disposed: string[] = [];

    mount(root, () =>
      each(
        () => users(),
        userKey,
        (user) => {
          const value = user();
          return legacy(createRow(value), () => disposed.push(userKey(value)));
        },
      ),
    );

    const alice = root.querySelector<HTMLElement>('[data-key="u1:active"]');
    const bob = root.querySelector<HTMLElement>('[data-key="u2:active"]');
    assert.ok(alice);
    assert.ok(bob);

    // Search narrows the list and keeps the matching row.
    users.set([{ id: 'u1', username: 'alice', frozen: false }]);
    flushEffects();
    assert.equal(root.querySelector('[data-key="u1:active"]'), alice);
    assert.deepEqual(disposed, ['u2:active']);

    // Freeze flips the key: only that row is recreated.
    users.set([{ id: 'u1', username: 'alice', frozen: true }]);
    flushEffects();
    assert.equal(root.querySelector('[data-key="u1:active"]'), null);
    assert.equal(root.querySelector('[data-key="u1:frozen"]')?.textContent, '@alice (frozen)');
    assert.deepEqual(disposed.sort(), ['u1:active', 'u2:active']);
  });
});
