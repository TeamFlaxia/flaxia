// Arcade display titles come from the game's HTML <title>, with the post body
// as the fallback. Covers both the shared resolver and its wiring.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { extractGameDescription } from '../functions/lib/game-metadata.ts';
import { arcadeGameTitle, cleanGameTitle } from '../shared/game-title.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('HTML title wins and is cleaned', () => {
  assert.equal(cleanGameTitle('  My <b>Game</b>  '), 'My Game');
  assert.equal(arcadeGameTitle('  My Game  ', 'post body', 'alice'), 'My Game');
});

test('post text is the fallback when the game has no HTML title', () => {
  assert.equal(arcadeGameTitle(null, 'post body', 'alice'), 'post body');
  assert.equal(arcadeGameTitle('', 'post body', 'alice'), 'post body');
  assert.equal(arcadeGameTitle(null, null, 'alice'), 'Game by @alice');
  assert.equal(arcadeGameTitle(null, null, null), 'Untitled Game');
});

test('the games API reads game_title and uses the shared resolver', async () => {
  const source = await read('functions/api/routes/games.ts');
  assert.equal((source.match(/p\.game_title/g) ?? []).length >= 4, true, 'all game SELECTs need game_title');
  assert.equal(
    (source.match(/arcadeGameTitle\(row\.game_title/g) ?? []).length,
    3,
    'all three feeds must use the resolver',
  );
});

test('direct HTML extraction stores the title and converges without one', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    "CREATE TABLE posts (id TEXT PRIMARY KEY, game_description TEXT, game_title TEXT); INSERT INTO posts VALUES ('p', '', NULL);",
  );
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
      };
    },
  } as unknown as D1Database;
  const bucket = (html: string) => ({ get: async () => ({ text: async () => html }) }) as unknown as R2Bucket;
  const stored = () =>
    sqlite.prepare('SELECT game_description, game_title FROM posts WHERE id = ?').get('p') as {
      game_description: string;
      game_title: string | null;
    };

  await extractGameDescription(
    bucket('<title>My &amp; Game</title><meta name="description" content="A game">'),
    db,
    'html/p.html',
    'p',
  );
  assert.equal(stored().game_title, 'My & Game');
  assert.equal(stored().game_description, 'A game');

  // A new release without <title> clears the HTML title; the empty string is
  // the processed sentinel so backfill never reselects this post.
  await extractGameDescription(bucket('<html><body>no title</body></html>'), db, 'html/p.html', 'p');
  assert.equal(stored().game_title, '');
  const pending = sqlite
    .prepare("SELECT id FROM posts WHERE (game_description IS NULL OR game_description = '' OR game_title IS NULL)")
    .all();
  assert.equal(pending.length, 0);
  sqlite.close();
});

test('publish, version-commit and thread reads persist/expose the HTML title', async () => {
  const extractor = await read('functions/lib/game-metadata.ts');
  assert.match(extractor, /UPDATE posts SET game_title = \?/, 'version/publish must persist the HTML title');
  const replies = await read('functions/api/routes/posts/replies.ts');
  assert.match(replies, /p\.game_title/, 'thread API must expose game_title');
  const migration = await read('migrations/0147_game_html_title.sql');
  assert.match(migration, /ADD COLUMN game_title/, 'the column must exist in D1');
});
