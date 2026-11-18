import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, html, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Row {
  id: string;
  label: string;
}

function createList(kind: string, rows: ReturnType<typeof signal<Row[]>>, disposed: string[]) {
  return each(
    () => rows(),
    (row) => `${kind}:${row.id}`,
    (row) => {
      const value = row();
      const element = document.createElement('div');
      element.dataset.kind = kind;
      element.dataset.id = value.id;
      element.textContent = value.label;
      return legacy(element, () => disposed.push(`${kind}:${value.id}`));
    },
  );
}

describe('render/search-lists', () => {
  it('keeps four independent keyed result lists in sync', () => {
    const root = document.createElement('div');
    const users = signal<Row[]>([{ id: 'u1', label: 'user' }]);
    const posts = signal<Row[]>([{ id: 'p1', label: 'post' }]);
    const arcade = signal<Row[]>([{ id: 'g1', label: 'game' }]);
    const web = signal<Row[]>([{ id: 'w1', label: 'web' }]);
    const disposed: string[] = [];

    mount(
      root,
      () => html`
        <div class="users">${createList('user', users, disposed)}</div>
        <div class="posts">${createList('post', posts, disposed)}</div>
        <div class="arcade">${createList('arcade', arcade, disposed)}</div>
        <div class="web">${createList('web', web, disposed)}</div>
      `,
    );

    const userRow = root.querySelector<HTMLElement>('[data-kind="user"]');
    const postRow = root.querySelector<HTMLElement>('[data-kind="post"]');
    assert.ok(userRow);
    assert.ok(postRow);

    // A new query updates every list. Rows with the same key survive.
    users.set([
      { id: 'u1', label: 'user updated' },
      { id: 'u2', label: 'second user' },
    ]);
    posts.set([{ id: 'p1', label: 'post updated' }]);
    arcade.set([]);
    web.set([{ id: 'w1', label: 'web updated' }]);
    flushEffects();

    assert.equal(root.querySelector('[data-kind="user"][data-id="u1"]'), userRow);
    assert.equal(root.querySelector('[data-kind="post"][data-id="p1"]'), postRow);
    assert.equal(root.querySelector('[data-kind="user"]')?.textContent, 'user');
    assert.equal(root.querySelector('[data-kind="user"][data-id="u2"]')?.textContent, 'second user');
    assert.equal(root.querySelector('[data-kind="arcade"][data-id="g1"]'), null);
    assert.deepEqual(disposed, ['arcade:g1']);
  });

  it('disposes all four legacy lists on unmount', () => {
    const root = document.createElement('div');
    const users = signal<Row[]>([{ id: 'u1', label: 'user' }]);
    const posts = signal<Row[]>([{ id: 'p1', label: 'post' }]);
    const arcade = signal<Row[]>([{ id: 'g1', label: 'game' }]);
    const web = signal<Row[]>([{ id: 'w1', label: 'web' }]);
    const disposed: string[] = [];

    const mounted = mount(
      root,
      () => html`
        ${createList('user', users, disposed)}
        ${createList('post', posts, disposed)}
        ${createList('arcade', arcade, disposed)}
        ${createList('web', web, disposed)}
      `,
    );

    mounted.dispose();
    assert.deepEqual(disposed.sort(), ['arcade:g1', 'post:p1', 'user:u1', 'web:w1']);
    assert.equal(root.querySelector('[data-kind]'), null);
  });
});
