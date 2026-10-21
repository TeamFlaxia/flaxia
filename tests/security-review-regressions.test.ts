import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';

// The route modules use Vite/Workers-style extensionless TypeScript imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.')
      ) {
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      }
      throw error;
    }
  },
});
const { default: games } = await import('../functions/api/routes/games.ts');
const { default: posts } = await import('../functions/api/routes/posts.ts');
const { loadOrComputeInterestVector } = await import('../functions/api/routes/recommender.ts');

// Execute route SQL in SQLite, with D1's 100-bound-parameter limit enforced.
// No live server or external services are needed for these regressions.
function fixture(authenticated = true) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT, display_name TEXT, avatar_key TEXT,
      badge_type TEXT, language TEXT, trust_score REAL DEFAULT 1.0,
      repetition_score REAL DEFAULT 0.0, trust_updated_at TEXT
    );
    INSERT INTO users (id, username, display_name) VALUES ('owner', 'owner', 'Owner');
    CREATE TABLE posts (
      id TEXT PRIMARY KEY, user_id TEXT, username TEXT, text TEXT DEFAULT '',
      hashtags TEXT DEFAULT '[]', mentions TEXT DEFAULT '[]', gif_key TEXT,
      payload_key TEXT, swf_key TEXT, thumbnail_key TEXT, quoted_post_id TEXT,
      engagement_hotness REAL, status TEXT DEFAULT 'published', hidden INTEGER DEFAULT 0,
      game_description TEXT, fresh_count INTEGER DEFAULT 0, bookmark_count INTEGER DEFAULT 0,
      reply_count INTEGER DEFAULT 0, impressions INTEGER DEFAULT 0, parent_id TEXT,
      root_id TEXT, depth INTEGER DEFAULT 0, edited_at TEXT, actor_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE post_attachments (post_id TEXT, r2_key TEXT, kind TEXT, position INTEGER);
    CREATE TABLE reactions (post_id TEXT, user_id TEXT, emoji TEXT);
    CREATE TABLE arcade_events (
      id TEXT PRIMARY KEY, user_id TEXT, post_id TEXT, session_id TEXT, position INTEGER,
      event_type TEXT, dwell_ms INTEGER, swipe_velocity REAL, did_skip INTEGER,
      is_fullscreen INTEGER, game_type TEXT
    );
    CREATE TABLE user_game_plays (
      id TEXT PRIMARY KEY, user_id TEXT, post_id TEXT, dwell_ms INTEGER,
      is_fullscreen INTEGER, game_type TEXT, source TEXT, created_at TEXT
    );
    CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, interest_vec TEXT, source_count INTEGER, updated_at TEXT);
    CREATE TABLE post_embeddings (post_id TEXT PRIMARY KEY, embedding TEXT, created_at TEXT);
    CREATE TABLE follows (follower_id TEXT, followee_id TEXT);
    CREATE TABLE blocks (blocker_id TEXT, blocked_id TEXT);
    CREATE TABLE freshs (user_id TEXT, post_id TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE bookmarks (user_id TEXT, post_id TEXT, created_at TEXT);
    CREATE TABLE shares (user_id TEXT, post_id TEXT, created_at TEXT);
    CREATE TABLE user_post_impressions (user_id TEXT, post_id TEXT, last_seen_at TEXT);
    CREATE TABLE polls (id TEXT, post_id TEXT);
  `);
  const validationQueries: SQLInputValue[][] = [];
  function statement(sql: string, values: SQLInputValue[] = []) {
    return {
      bind(...bound: SQLInputValue[]) {
        assert.ok(bound.length <= 100, `D1 bind limit exceeded: ${bound.length}`);
        return statement(sql, bound);
      },
      async first() {
        return sqlite.prepare(sql).get(...values) ?? null;
      },
      async all() {
        if (sql.startsWith('SELECT id FROM posts WHERE id IN')) validationQueries.push(values);
        return { success: true, results: sqlite.prepare(sql).all(...values) };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  const db = {
    prepare: statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      return Promise.all(statements.map((query) => query.run()));
    },
  } as unknown as D1Database;
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (authenticated) {
      c.set('user', { id: 'owner', username: 'owner', display_name: 'Owner' } as Variables['user']);
    }
    await next();
  });
  app.route('/', posts);
  app.route('/', games);
  const deletedKeys: string[] = [];
  const env = {
    DB: db,
    BASE_URL: 'http://localhost:8788',
    BUCKET: {
      async delete(key: string) {
        deletedKeys.push(key);
      },
    },
  } as unknown as Bindings;
  async function request(path: string, body: unknown, method = 'POST') {
    return app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body),
      },
      env,
    );
  }
  return { sqlite, db, validationQueries, deletedKeys, request };
}

describe('recommended feed D1 bind-limit regressions', () => {
  for (const [authenticated, limit] of [
    [false, 50],
    [true, 20],
    [true, 50],
  ] as const) {
    it(`paginates recent and older recommendations without suppressing seen or freshed posts (authenticated=${authenticated})`, async () => {
      const { sqlite, request } = fixture(authenticated);
      try {
        const insert = sqlite.prepare(
          'INSERT INTO posts (id, user_id, text, engagement_hotness, created_at) VALUES (?, ?, ?, ?, ?)',
        );
        const recent = new Date().toISOString();
        const oldFresh = new Date(Date.now() - 15 * 86400_000).toISOString();
        const old = new Date(Date.now() - 30 * 86400_000).toISOString();
        for (let i = 0; i < 120; i++) {
          insert.run(`recent-${i}`, `author-${i}`, 'A recent recommendation', 1, recent);
          insert.run(`popular-${i}`, `author-${i}`, 'An older popular recommendation', 100000, old);
        }
        sqlite
          .prepare('INSERT INTO freshs (user_id, post_id, created_at) VALUES (?, ?, ?)')
          .run('owner', 'recent-0', recent);
        sqlite
          .prepare('INSERT INTO freshs (user_id, post_id, created_at) VALUES (?, ?, ?)')
          .run('owner', 'recent-3', oldFresh);
        sqlite.exec(`
          INSERT INTO user_post_impressions VALUES ('owner', 'recent-1', '${recent}');
          INSERT INTO blocks VALUES ('owner', 'author-2');
        `);
        const firstResponse = await request(`/posts/recommended?limit=${limit}`, undefined, 'GET');
        assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
        const body = (await firstResponse.json()) as {
          posts: Array<{ id: string; user_id: string; score?: number }>;
          next_cursor: string | null;
        };
        assert.equal(body.posts.length, limit);
        assert.equal(new Set(body.posts.map((post) => post.id)).size, limit);
        assert.ok(body.next_cursor);

        const posts = [...body.posts];
        let cursor = body.next_cursor;
        const pagination = [cursor];
        for (let page = 0; page < 8 && cursor; page++) {
          const response = await request(
            `/posts/recommended?limit=${limit}&cursor=${encodeURIComponent(cursor)}`,
            undefined,
            'GET',
          );
          assert.equal(response.status, 200, await response.clone().text());
          const nextPage = (await response.json()) as {
            posts: Array<{ id: string; user_id: string; score?: number }>;
            next_cursor: string | null;
          };
          posts.push(...nextPage.posts);
          cursor = nextPage.next_cursor;
          pagination.push(cursor);
        }

        assert.ok(
          posts.some((post) => post.id.startsWith('popular-')),
          JSON.stringify(pagination),
        );
        if (authenticated) {
          assert.ok(posts.some((post) => post.id === 'recent-0'));
          assert.ok(posts.some((post) => post.id === 'recent-3'));
          assert.ok(posts.some((post) => post.id === 'recent-1'));
          assert.ok(posts.every((post) => post.user_id !== 'author-2'));
          const scores = new Map(posts.map((post) => [post.id, post.score]));
          assert.ok((scores.get('recent-0') ?? 1) < (scores.get('recent-4') ?? 0));
          assert.ok((scores.get('recent-1') ?? 1) < (scores.get('recent-4') ?? 0));
        }
      } finally {
        sqlite.close();
      }
    });
  }

  it('computes an interest profile from more than 100 distinct history posts', async () => {
    const { sqlite, db } = fixture();
    try {
      const insertPost = sqlite.prepare('INSERT INTO posts (id, user_id, parent_id) VALUES (?, ?, ?)');
      const insertEmbedding = sqlite.prepare('INSERT INTO post_embeddings (post_id, embedding) VALUES (?, ?)');
      const vector = JSON.stringify(Array.from({ length: 1024 }, (_, index) => Number(index === 0)));
      for (let i = 0; i < 120; i++) {
        const id = `history-${i}`;
        insertPost.run(id, 'author', null);
        insertEmbedding.run(id, vector);
        if (i < 40) sqlite.prepare('INSERT INTO freshs (user_id, post_id) VALUES (?, ?)').run('owner', id);
        else if (i < 70) sqlite.prepare('INSERT INTO bookmarks (user_id, post_id) VALUES (?, ?)').run('owner', id);
        else if (i < 100) insertPost.run(`reply-${i}`, 'owner', id);
        else sqlite.prepare('INSERT INTO shares (user_id, post_id) VALUES (?, ?)').run('owner', id);
      }
      const profile = await loadOrComputeInterestVector(db, 'owner');
      assert.equal(profile?.sourceCount, 120);
      assert.equal(profile?.vector[0], 1);
    } finally {
      sqlite.close();
    }
  });
});

describe('legacy media ownership regressions', () => {
  for (const [prefix, ext] of [
    ['audio', 'mp3'],
    ['video', 'mp4'],
  ]) {
    it(`publishes and edits owned legacy ${prefix} keys from the prepare routes`, async () => {
      const { sqlite, request } = fixture();
      try {
        const prepare = await request('/posts/prepare', { filename: `original.${ext}` });
        assert.equal(prepare.status, 200);
        const { postId, gifKey } = (await prepare.json()) as { postId: string; gifKey: string };
        assert.equal(gifKey, `${prefix}/${postId}.${ext}`);
        const commit = await request('/posts/commit', { postId, gifKey, text: 'Original media' });
        assert.equal(commit.status, 200, await commit.text());
        assert.equal(sqlite.prepare('SELECT status FROM posts WHERE id = ?').get(postId)?.status, 'published');

        const attachment = await request(`/posts/${postId}/prepare-attachment`, { filename: `edited.${ext}` });
        assert.equal(attachment.status, 200);
        const { key } = (await attachment.json()) as { key: string };
        assert.equal(key, `${prefix}/${postId}.${ext}`);
        const edit = await request(`/posts/${postId}`, { gif_key: key, text: 'Edited media' }, 'PUT');
        assert.equal(edit.status, 200, await edit.text());
        const stored = sqlite.prepare('SELECT gif_key, text FROM posts WHERE id = ?').get(postId);
        assert.equal(stored?.gif_key, key);
        assert.equal(stored?.text, 'Edited media');
      } finally {
        sqlite.close();
      }
    });

    it(`rejects another account's legacy ${prefix} keys on commit and edit without deleting objects`, async () => {
      const { sqlite, request, deletedKeys } = fixture();
      try {
        const ownedKey = `${prefix}/owned.${ext}`;
        const victimKey = `${prefix}/victim.${ext}`;
        sqlite
          .prepare('INSERT INTO posts (id, user_id, username, gif_key) VALUES (?, ?, ?, ?)')
          .run('owned', 'owner', 'owner', ownedKey);
        sqlite
          .prepare('INSERT INTO posts (id, user_id, username, gif_key) VALUES (?, ?, ?, ?)')
          .run('victim', 'other-user', 'other-user', victimKey);
        const commit = await request('/posts/commit', { postId: 'owned', gifKey: victimKey, text: 'Stolen' });
        assert.equal(commit.status, 422);
        const edit = await request('/posts/owned', { gif_key: victimKey }, 'PUT');
        assert.equal(edit.status, 422);
        assert.equal(sqlite.prepare("SELECT gif_key FROM posts WHERE id = 'owned'").get()?.gif_key, ownedKey);
        assert.deepEqual(deletedKeys, []);
      } finally {
        sqlite.close();
      }
    });
  }
});

describe('Arcade ingestion D1 bind-limit regressions', () => {
  for (const route of ['events', 'dwell']) {
    for (const size of [100, 101, 200]) {
      it(`records ${size} distinct published games through /games/${route}`, async () => {
        const { sqlite, validationQueries, request } = fixture();
        try {
          const ids = Array.from({ length: size }, (_, i) => `game-${i}`);
          const insert = sqlite.prepare('INSERT INTO posts (id, payload_key) VALUES (?, ?)');
          for (const id of ids) insert.run(id, `zip/${id}.zip`);
          const entries = ids.map((postId) => ({ postId, eventType: 'view', dwellMs: 3000, gameType: 'zip' }));
          const body = route === 'events' ? { sessionId: 'batch', events: entries } : { plays: entries };
          const response = await request(`/games/${route}`, body);
          assert.equal(response.status, 200, await response.text());
          assert.deepEqual(validationQueries.flat(), ids);
          assert.ok(validationQueries.every((values) => values.length <= 100));
          const stored = sqlite.prepare('SELECT post_id FROM user_game_plays ORDER BY post_id').all();
          assert.deepEqual(
            stored.map((row) => row.post_id),
            [...ids].sort(),
          );
          if (route === 'events') {
            assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM arcade_events').get()?.count, size);
          }
        } finally {
          sqlite.close();
        }
      });
    }

    it(`filters unknown, hidden, pending and non-game IDs across chunks in /games/${route}`, async () => {
      const { sqlite, validationQueries, request } = fixture();
      try {
        const ids = Array.from({ length: 104 }, (_, i) => `game-${i}`);
        const insert = sqlite.prepare(
          'INSERT INTO posts (id, payload_key, swf_key, status, hidden) VALUES (?, ?, ?, ?, ?)',
        );
        for (const id of ids.slice(0, 100)) insert.run(id, `zip/${id}.zip`, null, 'published', 0);
        insert.run(ids[100], null, 'swf/game.swf', 'published', 0);
        insert.run(ids[101], 'zip/hidden.zip', null, 'published', 1);
        insert.run(ids[102], 'zip/pending.zip', null, 'pending', 0);
        insert.run(ids[103], null, null, 'published', 0);
        const entries = [...ids, 'missing', ids[0]].map((postId) => ({ postId, eventType: 'view', dwellMs: 3000 }));
        const body = route === 'events' ? { sessionId: 'filtered', events: entries } : { plays: entries };
        const response = await request(`/games/${route}`, body);
        assert.equal(response.status, 200, await response.text());
        assert.deepEqual(validationQueries.flat(), [...ids, 'missing']);
        const stored = sqlite.prepare('SELECT post_id FROM user_game_plays ORDER BY post_id').all();
        assert.deepEqual(
          stored.map((row) => row.post_id),
          [...ids.slice(0, 101), ids[0]].sort(),
        );
      } finally {
        sqlite.close();
      }
    });
  }
});
