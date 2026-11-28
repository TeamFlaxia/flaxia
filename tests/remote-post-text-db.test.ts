// The 200-character CHECK on `posts.text` used to reject every long Fediverse
// Note before the handler could store it. The migration widens the bound for
// remote rows only; these tests exercise the real migrated SQLite schema.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestDatabase } from './helpers/d1.ts';

const CREATED_AT = '2026-01-01T00:00:00.000Z';

async function insertPost(
  db: ReturnType<typeof createTestDatabase>,
  id: string,
  text: string,
  actorId: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO posts (id, user_id, username, text, hashtags, status, created_at, actor_id)
       VALUES (?, '', 'author', ?, '[]', 'published', ?, ?)`,
    )
    .bind(id, text, CREATED_AT, actorId)
    .run();
}

describe('posts text constraint', () => {
  it('keeps local posts at 200 characters but stores long remote posts', async () => {
    const db = createTestDatabase();
    try {
      await insertPost(db, 'local-ok', 'a'.repeat(200), null);
      await assert.rejects(
        () => insertPost(db, 'local-too-long', 'a'.repeat(201), null),
        /length\(text\) <= 200/,
        'the local 200-character rule must survive the migration',
      );

      await insertPost(db, 'remote-long', 'あ'.repeat(250), 'https://remote.example/users/alice');
      await assert.rejects(
        () => insertPost(db, 'remote-too-long', 'あ'.repeat(10_001), 'https://remote.example/users/alice'),
        /CHECK constraint failed/,
        'remote text must still have a safety bound',
      );

      const stored = await db
        .prepare('SELECT length(text) AS length FROM posts WHERE id = ?')
        .bind('remote-long')
        .first<{ length: number }>();
      assert.equal(stored?.length, 250);

      // The table rebuild must preserve child rows and the search triggers.
      await db
        .prepare(
          "INSERT INTO post_attachments (post_id, r2_key, kind, position) VALUES ('local-ok', 'key', 'image', 0)",
        )
        .run();
      const attachments = await db.prepare('SELECT COUNT(*) AS n FROM post_attachments').first<{ n: number }>();
      assert.equal(attachments?.n, 1);

      // Self-references must still point at the rebuilt posts table.
      await db
        .prepare(
          "INSERT INTO posts (id, user_id, username, text, parent_id, created_at) VALUES ('reply', '', 'author', 'ok', 'local-ok', ?)",
        )
        .bind(CREATED_AT)
        .run();
      await assert.rejects(
        () =>
          db
            .prepare(
              "INSERT INTO posts (id, user_id, username, text, parent_id, created_at) VALUES ('orphan', '', 'author', 'ok', 'missing', ?)",
            )
            .bind(CREATED_AT)
            .run(),
        /FOREIGN KEY constraint failed/,
      );

      const searchRow = await db
        .prepare("SELECT body FROM search_documents WHERE document_type = 'post' AND ref_id = 'remote-long'")
        .first<{ body: string }>();
      assert.match(searchRow?.body ?? '', /あ/);
    } finally {
      db.close();
    }
  });
});
