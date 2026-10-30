import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deletionOperationHash, resumeAuthDeletion } from '../functions/lib/flaxia-auth-deletion.ts';

test('deletion resumes after a lost Auth response and a local transaction failure', async () => {
  const operation = 'A'.repeat(43);
  const operationHash = await deletionOperationHash(operation);
  const job = {
    user_id: 'user',
    grant_token: 'B'.repeat(43),
    proof_json: JSON.stringify({ challenge_id: 'challenge', A: 'A', M1: 'M' }),
    state: 'pending',
  };
  let receipt = false;
  let remoteCalls = 0;
  let localCalls = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind(hash: string) {
          assert.equal(hash, operationHash);
          return {
            async first() {
              if (sql.includes('deletion_receipts')) return receipt ? { ok: 1 } : null;
              if (sql.includes('deletion_jobs')) return { ...job };
              throw new Error(`unexpected query ${sql}`);
            },
            async run() {
              assert.match(sql, /UPDATE flaxia_auth_deletion_jobs/);
              job.state = 'approved';
              return { success: true };
            },
          };
        },
      };
    },
  };
  const service = {
    async fetch(request: Request) {
      const body = (await request.json()) as { operation: string };
      assert.equal(body.operation, operation);
      remoteCalls++;
      if (remoteCalls === 1) throw new Error('response lost after remote commit');
      return Response.json({ success: true });
    },
  };
  const env = { DB: db, AUTH_SERVICE: service } as unknown as Env;
  const local = async (_env: Env, userId: string, hash?: string) => {
    assert.equal(userId, 'user');
    assert.equal(hash, operationHash);
    localCalls++;
    if (localCalls === 1) throw new Error('local transaction rolled back');
    receipt = true;
  };
  assert.equal(await resumeAuthDeletion(env, operation, local), 'unavailable');
  assert.equal(job.state, 'pending');
  assert.equal(await resumeAuthDeletion(env, operation, local), 'unavailable');
  assert.equal(job.state, 'approved');
  assert.equal(await resumeAuthDeletion(env, operation, local), 'ok');
  assert.equal(await resumeAuthDeletion(env, operation, local), 'ok');
  assert.equal(remoteCalls, 2);
  assert.equal(localCalls, 2);
});
