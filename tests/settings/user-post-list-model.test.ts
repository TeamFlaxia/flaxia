import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildUserPostUrl, resolveUserPostPage } from '../../src/lib/svelte/user-post-list-model.ts';

interface Row {
  id: string;
  created_at: string;
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, created_at: `2026-01-0${id.slice(1)}T00:00:00Z` }));

describe('svelte/user-post-list-model', () => {
  it('builds the profile feed URLs for each tab', () => {
    assert.equal(buildUserPostUrl('posts', 'alice', undefined, 20), '/api/posts?limit=20&username=alice');
    assert.equal(buildUserPostUrl('freshs', 'alice', 'cursor-1', 20), '/api/freshs?limit=20&cursor=cursor-1');
    assert.equal(buildUserPostUrl('bookmarks', 'alice', 'cursor-2', 20), '/api/bookmarks?limit=20&cursor=cursor-2');
  });

  it('uses the explicit next cursor when the API sends one', () => {
    const page = resolveUserPostPage({ posts: rows('p1', 'p2'), nextCursor: 'next' }, 20);
    assert.deepEqual(
      page.posts.map((post) => post.id),
      ['p1', 'p2'],
    );
    assert.equal(page.next, 'next');
    assert.equal(page.more, true);
  });

  it('treats a null next cursor as the end of the list', () => {
    const page = resolveUserPostPage({ posts: rows('p1', 'p2'), nextCursor: null }, 20);
    assert.equal(page.next, undefined);
    assert.equal(page.more, false);
  });

  it('falls back to the last created_at when the API omits the cursor', () => {
    const full = rows('p1', 'p2');
    const page = resolveUserPostPage({ posts: full }, 2);
    assert.equal(page.next, full[1].created_at);
    assert.equal(page.more, true);
  });

  it('stops paging on a short page without a cursor', () => {
    const page = resolveUserPostPage({ posts: rows('p1') }, 2);
    assert.equal(page.next, '2026-01-01T00:00:00Z');
    assert.equal(page.more, false);
  });

  it('stops paging on an empty response', () => {
    const page = resolveUserPostPage({ posts: [] }, 20);
    assert.deepEqual(page.posts, []);
    assert.equal(page.next, undefined);
    assert.equal(page.more, false);
  });
});
