import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { each, flushEffects, legacy, mount, signal } from '../../src/lib/render/index.ts';

interface Post {
  id: string;
  label: string;
}

function createPostCard(post: Post): HTMLElement {
  const card = document.createElement('article');
  card.className = 'post-card';
  card.dataset.postId = post.id;
  card.textContent = post.label;
  return card;
}

function createList(posts: ReturnType<typeof signal<Post[]>>, disposed: string[]) {
  return each(
    () => posts(),
    (post) => post.id,
    (post) => {
      const value = post();
      const card = createPostCard(value);
      return legacy(card, () => disposed.push(value.id));
    },
  );
}

describe('profile/user-post-list', () => {
  it('prepends new posts without rebuilding existing cards', () => {
    const root = document.createElement('div');
    const posts = signal<Post[]>([
      { id: 'p1', label: 'first' },
      { id: 'p2', label: 'second' },
    ]);
    const disposed: string[] = [];

    const mounted = mount(root, () => createList(posts, disposed));
    const first = root.querySelector<HTMLElement>('[data-post-id="p1"]');
    const second = root.querySelector<HTMLElement>('[data-post-id="p2"]');
    assert.ok(first);
    assert.ok(second);

    // addPost(): prepend
    posts.set([{ id: 'p0', label: 'new' }, ...posts()]);
    flushEffects();

    assert.deepEqual(
      [...root.querySelectorAll<HTMLElement>('.post-card')].map((card) => card.dataset.postId),
      ['p0', 'p1', 'p2'],
    );
    assert.equal(root.querySelector('[data-post-id="p1"]'), first);
    assert.equal(root.querySelector('[data-post-id="p2"]'), second);

    // loadMore(): append
    posts.set([...posts(), { id: 'p3', label: 'more' }]);
    flushEffects();
    assert.equal(root.querySelector('[data-post-id="p1"]'), first);

    // onDelete(): remove
    posts.set(posts().filter((post) => post.id !== 'p2'));
    flushEffects();
    assert.deepEqual(disposed, ['p2']);

    mounted.dispose();
    assert.deepEqual(disposed.sort(), ['p0', 'p1', 'p2', 'p3']);
    assert.equal(root.querySelector('.post-card'), null);
  });
});
