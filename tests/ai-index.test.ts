import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { enrichPostsWithAiIndex, postTextSha } from '../functions/lib/ai-index.ts';
import { embedPost, handleCrowdWebhook } from '../functions/lib/crowd.ts';
import { stripPostColors } from '../src/lib/post-colors.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE posts (id TEXT PRIMARY KEY, text TEXT);
    CREATE TABLE post_embeddings (post_id TEXT PRIMARY KEY, embedding TEXT NOT NULL,
      model TEXT, dimensions INTEGER, bandit_vec TEXT, bandit_cfg TEXT);
    INSERT INTO posts VALUES ('p', 'hello text'), ('image', 'photo caption'), ('game', 'game description');`);
  sqlite.exec(readFileSync(new URL('../migrations/0111_embedding_source_sha.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...args: SQLInputValue[]) {
          values = args;
          return this;
        },
        async run() {
          sqlite.prepare(sql).run(...values);
          return { success: true };
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...values) };
        },
      };
    },
  } as unknown as D1Database;
  async function indexed(id = 'p') {
    const posts: Array<{ id: string; ai_indexed?: boolean }> = [{ id }];
    await enrichPostsWithAiIndex(posts, db);
    return posts[0].ai_indexed;
  }
  async function callback(sha: string | null, result: unknown = { vector: Array(1024).fill(0.01) }, status = 'done') {
    const params = new URLSearchParams({ type: 'vector-embed', postId: 'p' });
    if (sha !== null) params.set('sha', sha);
    return handleCrowdWebhook(
      new Request(`http://localhost/api/crowd/webhook?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'embedding-task', status, result }),
      }),
      { BASE_URL: 'http://localhost' },
      db,
    );
  }
  return { sqlite, db, indexed, callback };
}

test('text-only posts show indexed only after storing the embedding for their current text', async () => {
  const f = fixture();
  try {
    assert.equal(await f.indexed(), false);
    const sha = await postTextSha('hello text');
    assert.equal((await f.callback(sha)).status, 200);
    assert.equal(await f.indexed(), true);
    f.sqlite.exec(`UPDATE posts SET text = 'edited text' WHERE id = 'p'`);
    assert.equal(await f.indexed(), false, 'an old embedding cannot vouch for an edit');
    await f.callback(sha);
    assert.equal(await f.indexed(), false, 'a delayed result for the original text is ignored');
    await f.callback(await postTextSha('edited text'));
    assert.equal(await f.indexed(), true);
  } finally {
    f.sqlite.close();
  }
});

test('indexing applies to the text of image and game posts without depending on NSFW scans', async () => {
  const f = fixture();
  try {
    for (const [id, text] of [
      ['image', 'photo caption'],
      ['game', 'game description'],
    ]) {
      f.sqlite
        .prepare('INSERT INTO post_embeddings (post_id, embedding, source_sha) VALUES (?, ?, ?)')
        .run(id, '[0.1]', await postTextSha(text));
      assert.equal(await f.indexed(id), true);
    }
  } finally {
    f.sqlite.close();
  }
});

test('failed, malformed, and historical results do not claim successful current indexing', async () => {
  const f = fixture();
  try {
    const sha = await postTextSha('hello text');
    for (const result of [{}, { vector: [] }, { vector: ['bad'] }]) {
      await f.callback(sha, result);
      assert.equal(await f.indexed(), false);
    }
    await f.callback(sha, {}, 'failed');
    assert.equal(await f.indexed(), false);
    await f.callback(null);
    assert.equal(await f.indexed(), false, 'legacy callbacks lack text provenance');
    assert.equal(f.sqlite.prepare('SELECT source_sha FROM post_embeddings').get()?.source_sha, null);
  } finally {
    f.sqlite.close();
  }
});

test('embedding submissions sign the source text hash into the callback', async () => {
  let submitted: { callbackUrl?: string } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    submitted = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ taskId: 'task-new' }), { status: 200 });
  }) as typeof fetch;
  try {
    await embedPost(
      undefined,
      { BASE_URL: 'http://localhost', CROWD_ORCHESTRATOR_URL: 'https://crowd.example', CROWD_API_KEY: 'test-key' },
      'p',
      'hello text',
    );
    assert.ok(submitted?.callbackUrl);
    assert.equal(new URL(submitted.callbackUrl).searchParams.get('sha'), await postTextSha('hello text'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('embedding signs escaped color markers after a single strip', async () => {
  // `\{red}` is only idempotent for the first strip, so a double strip would
  // hash `literal` here and the callback would be rejected against the DB text.
  const text = '\\{red}literal{/red}';
  let submitted: { callbackUrl?: string } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    submitted = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ taskId: 'task-escaped' }), { status: 200 });
  }) as typeof fetch;
  try {
    await embedPost(
      undefined,
      { BASE_URL: 'http://localhost', CROWD_ORCHESTRATOR_URL: 'https://crowd.example', CROWD_API_KEY: 'test-key' },
      'escaped',
      text,
    );
    assert.ok(submitted?.callbackUrl);
    assert.equal(new URL(submitted.callbackUrl).searchParams.get('sha'), await postTextSha(stripPostColors(text)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
