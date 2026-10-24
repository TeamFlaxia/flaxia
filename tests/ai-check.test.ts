import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { enrichPostsWithAttachments } from '../functions/lib/attachments.ts';
import { ensureNsfwScansTable, handleCrowdWebhook } from '../functions/lib/crowd.ts';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE posts (id TEXT PRIMARY KEY, hashtags TEXT, gif_key TEXT, payload_key TEXT, swf_key TEXT);
    CREATE TABLE post_attachments (post_id TEXT, r2_key TEXT, kind TEXT, position INTEGER);
    CREATE TABLE file_scans (r2_key TEXT PRIMARY KEY, sha256 TEXT, status TEXT);
    INSERT INTO posts VALUES ('p', '[]', 'gif/p/0.png', NULL, NULL);
    INSERT INTO file_scans VALUES ('gif/p/0.png', 'content-v1', 'clean');
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
  await ensureNsfwScansTable(db);
  sqlite.exec(`INSERT INTO post_nsfw_scans (post_id, media_key, status, task_id, content_sha)
    VALUES ('p', 'gif/p/0.png', 'submitted', 'task-1', 'content-v1')`);
  async function verdict(result: unknown, taskId = 'task-1') {
    return handleCrowdWebhook(
      new Request('http://localhost/api/crowd/webhook?type=nsfw&postId=p&key=gif%2Fp%2F0.png', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, status: 'done', result }),
      }),
      { BASE_URL: 'http://localhost' },
      db,
    );
  }
  async function checked() {
    const posts: Array<{ id: string; ai_checked?: boolean }> = [{ id: 'p' }];
    await enrichPostsWithAttachments(posts, db);
    return posts[0].ai_checked;
  }
  return { sqlite, db, verdict, checked };
}

test('only a valid completed review of all current images earns the API badge', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.checked(), false, 'submitted is not approved');
    assert.equal((await f.verdict({ detections: [] })).status, 200);
    assert.equal(await f.checked(), true, 'an empty valid detection list passes');
    f.sqlite.exec(`INSERT INTO post_attachments VALUES ('p', 'gif/p/1.jpg', 'image', 1)`);
    assert.equal(await f.checked(), false, 'every attachment must be reviewed');
    f.sqlite.exec(`INSERT INTO file_scans VALUES ('gif/p/1.jpg', 'content-v2', 'clean');
      INSERT INTO post_nsfw_scans (post_id, media_key, status, task_id, content_sha, ai_passed)
      VALUES ('p', 'gif/p/1.jpg', 'done', 'task-2', 'content-v2', 1)`);
    assert.equal(await f.checked(), true);
    f.sqlite.exec(`UPDATE file_scans SET sha256 = 'replaced' WHERE r2_key = 'gif/p/0.png'`);
    assert.equal(await f.checked(), false, 'overwriting the same key invalidates approval');
    f.sqlite.exec(`UPDATE file_scans SET sha256 = 'content-v1', status = 'infected' WHERE r2_key = 'gif/p/0.png'`);
    assert.equal(await f.checked(), false, 'blocked files cannot earn a badge');
  } finally {
    f.sqlite.close();
  }
});

test('malformed outputs, stale callbacks, and NSFW verdicts cannot earn approval', async () => {
  const f = await fixture();
  try {
    for (const output of [{}, { detections: null }, { detections: [{}] }, { detections: [{ label: 'x', score: 2 }] }]) {
      assert.equal((await f.verdict(output)).status, 200);
      assert.equal(await f.checked(), false);
    }
    f.sqlite.exec(`UPDATE post_nsfw_scans SET status = 'submitted'`);
    await f.verdict({ detections: [] }, 'old-task');
    assert.equal(await f.checked(), false);
    await f.verdict({ detections: [{ label: 'FEMALE_GENITALIA_EXPOSED', score: 0.98, box: [0, 0, 10, 10] }] });
    assert.equal(await f.checked(), false);
    assert.equal(f.sqlite.prepare('SELECT ai_passed FROM post_nsfw_scans').get()?.ai_passed, 0);
  } finally {
    f.sqlite.close();
  }
});

test('unsupported, text-only, tagged, historical, and failed posts have no badge', async () => {
  const f = await fixture();
  try {
    await f.verdict({ output: { detections: [] } });
    assert.equal(await f.checked(), true);
    for (const tag of ['nsfw', 'R18']) {
      f.sqlite.prepare('UPDATE posts SET hashtags = ?').run(JSON.stringify([tag]));
      assert.equal(await f.checked(), false);
    }
    f.sqlite.exec(`UPDATE posts SET hashtags = '[]', payload_key = 'game.zip'`);
    assert.equal(await f.checked(), false);
    f.sqlite.exec(`UPDATE posts SET payload_key = NULL;
      INSERT INTO post_attachments VALUES ('p', 'video/p/1.mp4', 'video', 1)`);
    assert.equal(await f.checked(), false);
    f.sqlite.exec(`DELETE FROM post_attachments; UPDATE posts SET gif_key = NULL`);
    assert.equal(await f.checked(), false);
    f.sqlite.exec(`UPDATE posts SET gif_key = 'gif/p/0.png'; UPDATE post_nsfw_scans SET ai_passed = NULL`);
    assert.equal(await f.checked(), false);
    f.sqlite.exec(`UPDATE post_nsfw_scans SET ai_passed = 1, status = 'failed'`);
    assert.equal(await f.checked(), false);
  } finally {
    f.sqlite.close();
  }
});

test('migration keeps historical verdicts unknown', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`CREATE TABLE post_nsfw_scans (post_id TEXT, status TEXT);
      INSERT INTO post_nsfw_scans VALUES ('old', 'done')`);
    sqlite.exec(readFileSync(new URL('../migrations/0110_nsfw_ai_passed.sql', import.meta.url), 'utf8'));
    assert.equal(sqlite.prepare('SELECT ai_passed FROM post_nsfw_scans').get()?.ai_passed, null);
  } finally {
    sqlite.close();
  }
});
