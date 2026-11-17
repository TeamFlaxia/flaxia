import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Item {
  id: string;
  label: string;
}

function createSection(kind: string, items: ReturnType<typeof signal<Item[]>>, disposed: string[]) {
  return each(
    () => items(),
    (item) => item.id,
    (item) => {
      const value = item();
      const element = document.createElement('div');
      element.dataset.kind = kind;
      element.dataset.id = value.id;
      element.textContent = value.label;
      return legacy(element, () => disposed.push(`${kind}:${value.id}`));
    },
  );
}

describe('render/explore-sections', () => {
  it('keeps posts, arcade and users in independent keyed sections', () => {
    const root = document.createElement('div');
    const posts = signal<Item[]>([{ id: 'p1', label: 'post' }]);
    const arcade = signal<Item[]>([{ id: 'g1', label: 'game' }]);
    const users = signal<Item[]>([{ id: 'u1', label: 'user' }]);
    const disposed: string[] = [];

    const postsHost = document.createElement('div');
    const arcadeHost = document.createElement('div');
    const usersHost = document.createElement('div');
    root.append(postsHost, arcadeHost, usersHost);
    const postsMount = mount(postsHost, () => createSection('post', posts, disposed));
    const arcadeMount = mount(arcadeHost, () => createSection('arcade', arcade, disposed));
    const usersMount = mount(usersHost, () => createSection('user', users, disposed));

    const postNode = root.querySelector('[data-kind="post"][data-id="p1"]');
    const gameNode = root.querySelector('[data-kind="arcade"][data-id="g1"]');
    const userNode = root.querySelector('[data-kind="user"][data-id="u1"]');
    assert.ok(postNode);
    assert.ok(gameNode);
    assert.ok(userNode);

    posts.set([
      { id: 'p1', label: 'post' },
      { id: 'p2', label: 'second' },
    ]);
    arcade.set([]);
    users.set([
      { id: 'u1', label: 'user' },
      { id: 'u2', label: 'second' },
    ]);
    flushEffects();

    assert.equal(root.querySelector('[data-kind="post"][data-id="p1"]'), postNode);
    assert.equal(root.querySelector('[data-kind="user"][data-id="u1"]'), userNode);
    assert.equal(root.querySelector('[data-kind="arcade"][data-id="g1"]'), null);
    assert.equal(root.querySelector('[data-kind="post"][data-id="p2"]')?.textContent, 'second');
    assert.deepEqual(disposed, ['arcade:g1']);

    postsMount.dispose();
    arcadeMount.dispose();
    usersMount.dispose();
  });
});
