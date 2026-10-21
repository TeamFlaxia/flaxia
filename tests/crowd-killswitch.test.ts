// Ops kill-switch: CROWD_SCREENING_DISABLED=1 sheds Crowd submissions
// during an outage (screening skipped, embeds queued for later).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crowdConfig, embedPost, submitDetectNsfw } from '../functions/lib/crowd.ts';

// Minimal D1 stub: records statements, answers empty selects.
function fakeDb(queries: string[] = []) {
  const stmt = (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      first: async () => null,
      all: async () => ({ results: [], success: true }),
      run: async () => {
        queries.push(sql);
        return { success: true };
      },
    }),
  });
  return {
    prepare: (sql: string) => ({
      ...stmt(sql),
      first: async () => null,
      all: async () => ({ results: [], success: true }),
      run: async () => {
        queries.push(sql);
        return { success: true };
      },
    }),
    queries,
  } as unknown as D1Database;
}

const baseEnv = {
  CROWD_ORCHESTRATOR_URL: 'http://127.0.0.1:9',
  CROWD_API_KEY: 'test',
  BASE_URL: 'http://localhost:8788',
};

describe('CROWD_SCREENING_DISABLED kill-switch', () => {
  it('parses the flag (default off)', () => {
    assert.equal(crowdConfig(baseEnv).screeningDisabled, false);
    assert.equal(crowdConfig({ ...baseEnv, CROWD_SCREENING_DISABLED: '1' }).screeningDisabled, true);
    assert.equal(crowdConfig({ ...baseEnv, CROWD_SCREENING_DISABLED: '0' }).screeningDisabled, false);
  });

  it('submitDetectNsfw returns false without submitting', async () => {
    const db = fakeDb();
    const ok = await submitDetectNsfw(db, { ...baseEnv, CROWD_SCREENING_DISABLED: '1' }, 'post-1', 'gif/post-1/1.png');
    assert.equal(ok, false);
  });

  it('embedPost queues for later instead of submitting', async () => {
    const queries: string[] = [];
    const db = fakeDb(queries);
    await embedPost(db, { ...baseEnv, CROWD_SCREENING_DISABLED: '1' }, 'post-1', 'hello');
    assert.ok(
      queries.some((q) => q.includes('pending_embeddings')),
      'expected the embed to be queued for later',
    );
  });
});
