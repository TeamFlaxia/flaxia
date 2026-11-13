import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { enrichPostsWithRemoteAuthors } from '../functions/lib/activitypub/authors.ts';
import { createTestDatabase, seedLocalUser, type TestDatabase } from './helpers/d1.ts';

describe('remote author decoration', () => {
  let db: TestDatabase;

  before(async () => {
    db = createTestDatabase();
    await seedLocalUser(db, { id: 'local-1', username: 'alice' });
    await db
      .prepare(
        `INSERT INTO ap_actors (actor_url, inbox_url, preferred_username, display_name, icon_url, domain)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'https://remote.example/users/bob',
        'https://remote.example/users/bob/inbox',
        'bob',
        'Bob Remote',
        'https://remote.example/avatars/bob.png',
        'remote.example',
      )
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, user_id, username, text, hashtags, status, actor_id, ap_object_id, created_at)
       VALUES ('remote-post', '', 'bob@remote.example', 'hello from the fediverse', '[]', 'published',
               'https://remote.example/users/bob', 'https://remote.example/notes/1',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, user_id, username, text, hashtags, status, created_at)
       VALUES ('local-post', 'local-1', 'alice', 'hello locally', '[]', 'published',
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      )
      .run();
  });

  after(() => db.close());

  it('fills the author of a remote post from ap_actors', async () => {
    const post: Record<string, unknown> = { id: 'remote-post', user_id: '', username: 'bob@remote.example' };
    await enrichPostsWithRemoteAuthors([post], db as unknown as D1Database);
    assert.equal(post.user_id, 'https://remote.example/users/bob');
    assert.equal(post.actor_id, 'https://remote.example/users/bob');
    assert.equal(post.username, 'bob@remote.example');
    assert.equal(post.display_name, 'Bob Remote');
    assert.equal(post.avatar_url, 'https://remote.example/avatars/bob.png');
    assert.equal(post.avatar_key, null);
    assert.equal(post.is_remote, true);
    assert.equal(post.profile_path, '/@remote.example/bob');
  });

  it('leaves a local post alone', async () => {
    const post: Record<string, unknown> = { id: 'local-post', user_id: 'local-1', username: 'alice' };
    await enrichPostsWithRemoteAuthors([post], db as unknown as D1Database);
    assert.equal(post.user_id, 'local-1');
    assert.equal(post.username, 'alice');
    assert.equal(post.is_remote, undefined);
  });

  it('decorates a quoted remote post too', async () => {
    const quoted: Record<string, unknown> = { id: 'remote-post' };
    const post: Record<string, unknown> = {
      id: 'local-post',
      user_id: 'local-1',
      username: 'alice',
      quoted_post: quoted,
    };
    await enrichPostsWithRemoteAuthors([post], db as unknown as D1Database);
    assert.equal(quoted.username, 'bob@remote.example');
    assert.equal(quoted.is_remote, true);
    assert.equal(quoted.profile_path, '/@remote.example/bob');
  });
});
