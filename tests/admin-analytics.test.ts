import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';
import { getAdminAnalytics, parseAnalyticsDays } from '../functions/lib/admin-analytics.ts';

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
const { default: admin } = await import('../functions/api/routes/admin.ts');

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, created_at TEXT);
    CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT, created_at TEXT);
    CREATE TABLE freshs (post_id TEXT, user_id TEXT, created_at TEXT);
    CREATE TABLE user_game_plays (id TEXT PRIMARY KEY, user_id TEXT, dwell_ms INTEGER, created_at TEXT);
  `);
  // Applying twice must be safe. Use the real migration, not a parallel schema.
  const migration = readFileSync(new URL('../migrations/0109_admin_analytics_indexes.sql', import.meta.url), 'utf8');
  sqlite.exec(migration);
  sqlite.exec(migration);
  let queries = 0;
  const db = {
    prepare(sql: string) {
      queries++;
      const statement = {
        values: [] as SQLInputValue[],
        bind(...values: SQLInputValue[]) {
          this.values = values;
          return this;
        },
        async all() {
          return { success: true, results: sqlite.prepare(sql).all(...this.values) };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ all(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.all()));
    },
  } as unknown as D1Database;
  return { sqlite, db, queryCount: () => queries };
}

const now = new Date('2026-10-22T12:00:00.000Z');

test('analytics bounds periods, fills zero days, and deduplicates users across event types and days', async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite.exec(`
      INSERT INTO users VALUES ('a', '2026-10-16T00:00:00.000Z'), ('b', '2026-01-01T00:00:00.000Z'),
        ('signup-only', '2026-10-22T00:00:00.000Z');
      INSERT INTO posts VALUES ('first', 'a', '2026-10-16T00:00:00.000Z'),
        ('second', 'a', '2026-10-22T11:59:59.999Z'),
        ('old', 'b', '2026-10-15T23:59:59.999Z'),
        ('future', 'b', '2026-10-22T12:00:00.000Z'),
        ('remote', 'remote-actor', '2026-10-22T01:00:00.000Z');
      INSERT INTO freshs VALUES ('first', 'a', '2026-10-16T10:00:00.000Z'),
        ('first', 'b', '2026-10-22T02:00:00.000Z'), ('first', 'deleted-user', '2026-10-22T02:00:00.000Z');
      INSERT INTO user_game_plays VALUES ('p1', 'a', 60000, '2026-10-22T01:00:00.000Z'),
        ('p2', 'a', 30000, '2026-10-22T02:00:00.000Z');
    `);
    const data = await getAdminAnalytics(db, 7, now);
    assert.equal(data.start, '2026-10-16T00:00:00.000Z');
    assert.equal(data.end, now.toISOString());
    assert.equal(data.timezone, 'UTC');
    assert.equal(data.daily.length, 7);
    assert.deepEqual(data.summary, {
      new_users: 2,
      posts: 2,
      freshs: 2,
      game_plays: 2,
      active_users: 2,
      dwell_ms: 90000,
    });
    assert.deepEqual(data.totals, { users: 3, posts: 4 });
    assert.deepEqual(data.daily[1], {
      day: '2026-10-17',
      new_users: 0,
      posts: 0,
      freshs: 0,
      game_plays: 0,
      active_users: 0,
      dwell_ms: 0,
    });
    assert.equal(data.daily[0].active_users, 1);
    assert.equal(data.daily[6].active_users, 2);
    assert.equal(data.summary.active_users, 2, 'period users must not be the sum of daily users');
    assert.doesNotMatch(JSON.stringify(data), /remote-actor|signup-only|deleted-user/);
  } finally {
    sqlite.close();
  }
});

test('empty databases return numeric zeros and calendar ranges across month/year boundaries', async () => {
  const { sqlite, db } = fixture();
  try {
    for (const days of [7, 30, 90]) {
      const data = await getAdminAnalytics(db, days, new Date('2026-01-02T00:00:00.000Z'));
      assert.equal(data.daily.length, days);
      assert.equal(data.daily.at(-1)?.day, '2026-01-02');
      assert.ok(Object.values(data.summary).every((value) => value === 0));
      assert.deepEqual(data.totals, { users: 0, posts: 0 });
    }
  } finally {
    sqlite.close();
  }
});

test('days allowlist rejects malformed and unbounded input', () => {
  assert.equal(parseAnalyticsDays(undefined), 30);
  for (const value of ['7', '30', '90']) assert.equal(parseAnalyticsDays(value), Number(value));
  for (const value of ['', '0', '-1', '365', '7x', '07', '7.0', ' 7', '1 OR 1=1'])
    assert.equal(parseAnalyticsDays(value), null);
});

function appFor(db: D1Database, role: string | null) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', role === null ? null : ({ id: 'admin-id', username: 'operator', role } as Variables['user']));
    await next();
  });
  app.route('/api/admin', admin);
  return { request: (path: string) => app.request(path, {}, { DB: db, ADMIN_USERNAMES: '' } as Bindings) };
}

test('anonymous, ordinary, and reviewer users cannot read analytics or admin access; no DB queries run', async () => {
  for (const role of [null, 'user', 'reviewer']) {
    const { sqlite, db, queryCount } = fixture();
    try {
      for (const path of ['/api/admin/analytics', '/api/admin/access']) {
        const response = await appFor(db, role).request(path);
        assert.equal(response.status, role === null ? 401 : 403);
      }
      assert.equal(queryCount(), 0);
    } finally {
      sqlite.close();
    }
  }
});

test('admin can read aggregate analytics with private no-store headers; validation precedes SQL', async () => {
  const { sqlite, db, queryCount } = fixture();
  try {
    const app = appFor(db, 'admin');
    assert.equal((await app.request('/api/admin/access')).status, 200);
    const invalid = await app.request('/api/admin/analytics?days=365');
    assert.equal(invalid.status, 400);
    assert.equal(queryCount(), 0);
    const response = await app.request('/api/admin/analytics?days=7');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const data = await response.json();
    assert.equal(data.daily.length, 7);
    assert.equal(data.summary.active_users, 0);
    assert.equal((await (await app.request('/api/admin/analytics')).json()).days, 30);
  } finally {
    sqlite.close();
  }
});

test('database failures do not expose query details to administrators', async () => {
  const response = await appFor(
    {
      prepare() {
        throw new Error('internal DB detail');
      },
    } as unknown as D1Database,
    'admin',
  ).request('/api/admin/analytics');
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { error: 'Failed to fetch analytics' });
});

test('GA4 tag and reporting hooks are absent from application entry points', () => {
  for (const file of [
    'index.html',
    'src/lib/performance.ts',
    'src/types/global.d.ts',
    'public/_headers',
    'functions/lib/ssr-security-headers.ts',
  ]) {
    assert.doesNotMatch(
      readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
      /gtag|googletagmanager|google-analytics\.com|G-JZWZ08QFCW/,
    );
  }
});
