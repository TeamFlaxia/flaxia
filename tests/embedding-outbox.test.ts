// Regression coverage for the pending_embeddings outbox: text provenance,
// retry budget, kill-switch, and callback acknowledgement.
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { postTextSha } from '../functions/lib/ai-index.ts';
import { drainPendingEmbeds, enqueuePendingEmbed, handleCrowdWebhook } from '../functions/lib/crowd.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE posts (id TEXT PRIMARY KEY, text TEXT);
    CREATE TABLE post_embeddings (post_id TEXT PRIMARY KEY, embedding TEXT, model TEXT, dimensions INTEGER, source_sha TEXT);
    CREATE TABLE pending_embeddings (
      post_id TEXT PRIMARY KEY, text TEXT NOT NULL, payload TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_error TEXT
    );
    INSERT INTO posts VALUES ('p', 'hello text');
  `);
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
  return { sqlite, db };
}

function row(sqlite: DatabaseSync) {
  return sqlite.prepare('SELECT text, payload, attempts FROM pending_embeddings WHERE post_id = ?').get('p') as
    | { text: string; payload: string | null; attempts: number }
    | undefined;
}

async function callback(sqlite: DatabaseSync, db: D1Database, sha: string, text = 'hello text') {
  sqlite.prepare('UPDATE posts SET text = ? WHERE id = ?').run(text, 'p');
  return handleCrowdWebhook(
    new Request(`http://localhost/api/crowd/webhook?type=vector-embed&postId=p&sha=${sha}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1', status: 'done', result: { vector: Array(768).fill(0.01) } }),
    }),
    { BASE_URL: 'http://localhost' },
    db,
  );
}

test('re-enqueue refreshes stale text and preserves the retry budget for unchanged text', async () => {
  const f = fixture();
  try {
    await enqueuePendingEmbed(f.db, 'p', 'old text', 3, 'submission failed', JSON.stringify({ imageUrls: ['a'] }));
    await enqueuePendingEmbed(f.db, 'p', 'new text');
    assert.equal(row(f.sqlite)?.text, 'new text');
    assert.equal(row(f.sqlite)?.attempts, 0, 'changed text starts a fresh budget');
    assert.equal(row(f.sqlite)?.payload, JSON.stringify({ imageUrls: ['a'] }), 'media survives a text-only re-enqueue');

    await enqueuePendingEmbed(f.db, 'p', 'new text', 2);
    assert.equal(row(f.sqlite)?.attempts, 2);
    await enqueuePendingEmbed(f.db, 'p', 'new text', 0);
    assert.equal(row(f.sqlite)?.attempts, 2, 'feed re-dispatch cannot reset an existing retry budget');
  } finally {
    f.sqlite.close();
  }
});

test('a stale vector callback re-queues the current text instead of dropping the post', async () => {
  const f = fixture();
  try {
    const staleSha = await postTextSha('hello text');
    await enqueuePendingEmbed(f.db, 'p', 'hello text', 1);
    const response = await callback(f.sqlite, f.db, staleSha, 'edited text');
    assert.equal(response.status, 200);
    assert.equal(row(f.sqlite)?.text, 'edited text');
    assert.equal(row(f.sqlite)?.attempts, 1);
  } finally {
    f.sqlite.close();
  }
});

test('a successful vector callback acknowledges and retires the outbox row', async () => {
  const f = fixture();
  try {
    await enqueuePendingEmbed(f.db, 'p', 'hello text', 3, 'submitted, awaiting callback');
    const response = await callback(f.sqlite, f.db, await postTextSha('hello text'));
    assert.equal(response.status, 200);
    assert.equal(row(f.sqlite), undefined);
  } finally {
    f.sqlite.close();
  }
});

test('the kill-switch keeps the scheduled drain from submitting tasks', async () => {
  const f = fixture();
  try {
    await enqueuePendingEmbed(f.db, 'p', 'hello text');
    const originalFetch = globalThis.fetch;
    let submitted = false;
    globalThis.fetch = (async () => {
      submitted = true;
      throw new Error('must not submit while kill-switched');
    }) as typeof fetch;
    try {
      const result = await drainPendingEmbeds(
        f.db,
        {
          BASE_URL: 'http://localhost',
          CROWD_ORCHESTRATOR_URL: 'https://crowd.example',
          CROWD_API_KEY: 'test-key',
          CROWD_SCREENING_DISABLED: '1',
        },
        { respectThrottle: false },
      );
      assert.equal(result.submitted, 0);
      assert.equal(submitted, false);
      assert.equal(row(f.sqlite)?.text, 'hello text', 'the row stays queued for later');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    f.sqlite.close();
  }
});
