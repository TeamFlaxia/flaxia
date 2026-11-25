import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// EXPLAIN QUERY PLAN was run against all migrations: five hot queries still
// build temp B-trees or sorts. 0146 adds five additive indexes, and two route
// queries are rewritten so SQLite can actually use them. This suite pins both
// halves of that fix: the migration must stay strictly additive, the games
// trending branch must force its index, and the follow lists must drive from
// `users` with an EXISTS probe so ORDER BY u.username ASC needs no sort.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations/0146_click_latency_indexes.sql');
const GAMES = join(ROOT, 'functions/api/routes/games.ts');
const PROFILES = join(ROOT, 'functions/api/routes/users/profiles.ts');

type IndexDef = { name: string; table: string; columns: string; where: string };

// Collapse whitespace and the spaces around '=' so the assertions read
// naturally while tolerating SQL formatting differences.
function normalize(sql: string): string {
  return sql
    .replace(/\s*=\s*/g, '=')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

// Only plain CREATE INDEX IF NOT EXISTS is allowed — no tables, no UNIQUE,
// no DDL that can mutate data. Handles expression columns and partial WHERE.
function parseIndexes(sql: string): IndexDef[] {
  return statements(sql).map((statement) => {
    const match = statement.match(
      /^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+(\S+)\s+ON\s+(\w+)\s*\((.*)\)(?:\s+WHERE\s+([\s\S]*))?$/is,
    );
    assert.ok(
      match,
      `0146 must contain only "CREATE INDEX IF NOT EXISTS ... ON ... (...) [WHERE ...]" statements, got: ${statement}`,
    );
    return {
      name: match[1] as string,
      table: normalize(match[2] as string),
      columns: normalize(match[3] as string),
      where: match[4] ? normalize(match[4]) : '',
    };
  });
}

const EXPECTED: IndexDef[] = [
  {
    name: 'idx_posts_username_timeline',
    table: 'posts',
    columns: 'username, hidden, status, created_at desc',
    where: '',
  },
  {
    name: 'idx_posts_timeline_id',
    table: 'posts',
    columns: 'status, parent_id, created_at desc, id desc',
    where: "parent_id is null and status='published' and hidden=0",
  },
  {
    name: 'idx_posts_dup_cover',
    table: 'posts',
    columns: 'user_id, text, hidden, parent_id, created_at',
    where: "status='published'",
  },
  {
    name: 'idx_posts_games_trending',
    table: 'posts',
    columns: '(fresh_count + impressions) desc, created_at desc',
    where: "parent_id is null and status='published' and hidden=0 and payload_key is not null and swf_key is null",
  },
  {
    name: 'idx_reactions_post_emoji',
    table: 'reactions',
    columns: 'post_id, emoji',
    where: '',
  },
];

describe('migrations/0146_click_latency_indexes.sql', () => {
  it('exists', () => {
    assert.ok(existsSync(MIGRATION), 'missing migrations/0146_click_latency_indexes.sql');
  });

  it('is additive and no-op-safe (only CREATE INDEX IF NOT EXISTS statements plus comments)', () => {
    const defs = parseIndexes(readFileSync(MIGRATION, 'utf8'));
    assert.equal(defs.length, EXPECTED.length, `expected ${EXPECTED.length} indexes`);
  });

  for (const expected of EXPECTED) {
    it(`adds ${expected.name} on ${expected.table} with the exact columns/predicate`, () => {
      const defs = parseIndexes(readFileSync(MIGRATION, 'utf8'));
      const found = defs.find((def) => def.name === expected.name);
      assert.ok(found, `missing ${expected.name}`);
      assert.equal(found?.table, expected.table, `${expected.name}: wrong table`);
      assert.equal(found?.columns, expected.columns, `${expected.name}: wrong columns`);
      assert.equal(found?.where, expected.where, `${expected.name}: wrong WHERE predicate`);
    });
  }

  it('adds exactly the five verified indexes', () => {
    const defs = parseIndexes(readFileSync(MIGRATION, 'utf8'));
    assert.deepEqual(defs.map((def) => def.name).sort(), EXPECTED.map((def) => def.name).sort());
  });

  it('explains each index in comments', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    for (const keyword of ['/api/posts?username=', 'ORDER BY', 'cover', '0052', 'GROUP BY']) {
      assert.match(sql, new RegExp(keyword.replace(/[?()]/g, '\\$&'), 'i'), `missing comment about ${keyword}`);
    }
  });
});

describe('games.ts trending index pairing', () => {
  const source = readFileSync(GAMES, 'utf8');

  it('uses INDEXED BY idx_posts_games_trending exactly once', () => {
    const occurrences = source.match(/INDEXED BY/g) ?? [];
    assert.equal(occurrences.length, 1, 'the forced index must appear exactly once in games.ts');
    assert.match(source, /INDEXED BY idx_posts_games_trending\b/);
  });

  it('forces the index only in the trending branch, never in non-trending branches', () => {
    const block = source.match(/if \(trending\) \{([\s\S]*?)\}\s*else\s*\{([\s\S]*?)\}/);
    assert.ok(block, 'could not locate the trending/non-trending ORDER BY branches');
    const trendingBody = block?.[1] ?? '';
    const nonTrendingBody = block?.[2] ?? '';
    assert.match(trendingBody, /INDEXED BY idx_posts_games_trending/, 'trending branch must force the index');
    assert.doesNotMatch(nonTrendingBody, /INDEXED BY/, 'non-trending branch must not force an index');
    assert.match(trendingBody, /fresh_count \+ p\.impressions\) DESC/, 'trending ORDER BY must be preserved');
    assert.match(nonTrendingBody, /ORDER BY p\.created_at DESC/, 'recent ORDER BY must be preserved');
  });
});

describe('profiles.ts follow lists drive from users', () => {
  const source = readFileSync(PROFILES, 'utf8');

  function listQuery(marker: string): string {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `missing ${marker}`);
    const rest = source.slice(start);
    const end = rest.indexOf('const results = await c.env.DB.prepare(query)');
    assert.notEqual(end, -1, `could not find query for ${marker}`);
    return rest.slice(0, end);
  }

  const followers = listQuery('// GET /users/:username/followers - get paginated followers list');
  const following = listQuery('// GET /users/:username/following - get paginated following list');

  for (const [label, query] of [
    ['followers', followers],
    ['following', following],
  ] as const) {
    it(`${label} reads FROM users with an EXISTS probe on follows`, () => {
      assert.match(query, /\bFROM users u\b/, `${label} must drive from users`);
      assert.match(query, /EXISTS\s*\(/, `${label} must probe follows with EXISTS`);
      assert.doesNotMatch(query, /FROM follows f\s+JOIN users u/, `${label} must not drive from follows`);
    });

    it(`${label} preserves ordering, cursor and pagination`, () => {
      assert.match(query, /u\.username > \?/, `${label} must keep the username cursor`);
      assert.match(query, /ORDER BY u\.username ASC/, `${label} must keep username ordering`);
      assert.match(query, /LIMIT \?/, `${label} must keep the LIMIT parameter`);
    });
  }
});
