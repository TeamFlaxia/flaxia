import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  anonymizeId,
  buildDatasetRecords,
  type DatasetEventRow,
  loadOrCreateSalt,
  serializeRecords,
  truncateToHour,
} from '../functions/lib/dataset-export.ts';

describe('dataset-export', () => {
  it('anonymizeId is deterministic per (id, salt) and salt-rotatable', async () => {
    const a = await anonymizeId('user1', 'salt');
    const b = await anonymizeId('user1', 'salt');
    const c = await anonymizeId('user1', 'other');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]+$/);
    assert.equal(a.length, 24);
  });

  it('anonymizeId is not reversible to the raw id', async () => {
    const a = await anonymizeId('user-secret-email@example.com', 'salt');
    assert.ok(!a.includes('example.com'));
    assert.notEqual(a, 'user-secret-email@example.com');
  });

  it('buildDatasetRecords hashes ids, keeps embeddings, and sets labels', async () => {
    const events: DatasetEventRow[] = [
      {
        user_id: 'u1',
        session_id: 's1',
        post_id: 'p1',
        position: 0,
        event_type: 'view',
        dwell_ms: 1000,
        did_skip: 1,
        is_fullscreen: 0,
        swipe_velocity: 0.5,
        game_type: 'zip',
        created_at: '2026-08-03T04:05:00.000Z',
      },
      {
        user_id: 'u1',
        session_id: 's1',
        post_id: 'p2',
        position: 1,
        event_type: 'fresh',
        dwell_ms: 5000,
        did_skip: 0,
        is_fullscreen: 1,
        swipe_velocity: 0.1,
        game_type: 'zip',
        created_at: '2026-08-03T04:06:00.000Z',
      },
    ];
    const embeddings = new Map([['p1', [0.1, 0.2, 0.3]]]);

    const records = await buildDatasetRecords(events, embeddings, 'salt');
    assert.equal(records.length, 2);
    assert.notEqual(records[0].user_id, 'u1');
    assert.notEqual(records[0].post_id, 'p1');
    assert.equal(records[0].post_embedding?.[0], 0.1);
    assert.equal(records[1].post_embedding, null);
    assert.equal(records[0].label, 1000 / 30000);
    assert.equal(records[1].label, 1);
    assert.equal(records[0].game_type, 'zip');
    assert.equal(records[1].did_skip, 0);
  });

  it('hashing is consistent across records for the same ids', async () => {
    const event: DatasetEventRow = {
      user_id: 'u1',
      session_id: 's1',
      post_id: 'p1',
      position: 0,
      event_type: 'view',
      dwell_ms: 1000,
      did_skip: 0,
      is_fullscreen: 0,
      swipe_velocity: 0,
      game_type: 'zip',
      created_at: '2026-08-03T04:05:00.000Z',
    };
    const a = await buildDatasetRecords([event], new Map(), 'salt');
    const b = await buildDatasetRecords([event], new Map(), 'salt');
    assert.equal(a[0].user_id, b[0].user_id);
    assert.equal(a[0].post_id, b[0].post_id);
    assert.equal(a[0].session_id, b[0].session_id);
  });

  it('truncateToHour truncates to the top of the hour', () => {
    assert.equal(truncateToHour('2026-08-03T04:05:12.123Z'), '2026-08-03T04:00:00.000Z');
    assert.equal(truncateToHour('2026-08-03T23:59:59.999Z'), '2026-08-03T23:00:00.000Z');
    assert.equal(truncateToHour('garbage'), 'garbage');
  });

  it('serializeRecords produces newline-delimited JSON', async () => {
    const event: DatasetEventRow = {
      user_id: 'u1',
      session_id: 's1',
      post_id: 'p1',
      position: 0,
      event_type: 'view',
      dwell_ms: 1000,
      did_skip: 0,
      is_fullscreen: 0,
      swipe_velocity: 0,
      game_type: 'zip',
      created_at: '2026-08-03T04:05:00.000Z',
    };
    const records = await buildDatasetRecords([event, event], new Map(), 'salt');
    const jsonl = serializeRecords(records);
    assert.ok(jsonl.endsWith('\n'));
    assert.equal(jsonl.trim().split('\n').length, 2);
    // each line parses and includes no raw ids
    for (const line of jsonl.trim().split('\n')) {
      const parsed = JSON.parse(line);
      assert.notEqual(parsed.user_id, 'u1');
      assert.ok('label' in parsed);
      assert.ok('hour' in parsed);
    }
  });

  it('records carry hour only, never full-precision timestamps', async () => {
    const event: DatasetEventRow = {
      user_id: 'u1',
      session_id: 's1',
      post_id: 'p1',
      position: 0,
      event_type: 'view',
      dwell_ms: 1000,
      did_skip: 0,
      is_fullscreen: 0,
      swipe_velocity: 0,
      game_type: 'zip',
      created_at: '2026-08-03T04:05:12.123Z',
    };
    const [record] = await buildDatasetRecords([event], new Map(), 'salt');
    assert.ok(!('created_at' in record), 'full-precision timestamps must not be exported');
    assert.equal(record.hour, '2026-08-03T04:00:00.000Z');
  });

  it('salt without KV is ephemeral, never a public constant', async () => {
    const a = await loadOrCreateSalt(undefined);
    const b = await loadOrCreateSalt(undefined);
    assert.notEqual(a, 'no-kv-salt');
    assert.notEqual(a, b);
  });
});
