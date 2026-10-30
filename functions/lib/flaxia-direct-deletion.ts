import { deleteAccount } from './account-deletion.ts';
import { authDeletionCompleted } from './flaxia-auth.ts';
import { deletionOperationHash } from './flaxia-auth-deletion.ts';

type DirectDeletionEnv = { DB: D1Database; AUTH_SERVICE?: Fetcher; BUCKET?: R2Bucket };

export async function resumeDirectDeletion(
  env: DirectDeletionEnv,
  operation: string,
): Promise<'ok' | 'pending' | 'not_found' | 'unavailable'> {
  const hash = await deletionOperationHash(operation);
  if (!hash) return 'not_found';
  return resumeDirectDeletionHash(env, hash);
}

async function resumeDirectDeletionHash(
  env: DirectDeletionEnv,
  hash: string,
): Promise<'ok' | 'pending' | 'not_found' | 'unavailable'> {
  try {
    if (await env.DB.prepare('SELECT 1 FROM flaxia_auth_deletion_receipts WHERE operation_hash = ?').bind(hash).first())
      return 'ok';
    const job = await env.DB.prepare('SELECT user_id, state FROM flaxia_direct_deletion_jobs WHERE operation_hash = ?')
      .bind(hash)
      .first<{ user_id: string; state: string }>();
    if (!job) return 'not_found';
    if (job.state === 'pending') {
      const deleted = await authDeletionCompleted(env as { AUTH_SERVICE?: Fetcher }, hash, job.user_id);
      if (deleted === null) return 'unavailable';
      if (!deleted) return 'pending';
      await env.DB.prepare(
        "UPDATE flaxia_direct_deletion_jobs SET state = 'approved' WHERE operation_hash = ? AND user_id = ? AND state = 'pending'",
      )
        .bind(hash, job.user_id)
        .run();
    }
    await deleteAccount(env as Env, job.user_id, hash, true);
    return 'ok';
  } catch {
    try {
      if (
        await env.DB.prepare('SELECT 1 FROM flaxia_auth_deletion_receipts WHERE operation_hash = ?').bind(hash).first()
      )
        return 'ok';
    } catch {
      /* preserve retryability */
    }
    return 'unavailable';
  }
}

// Run from the scheduled worker as well as browser retries, so deletion still
// finishes when the initiating browser loses its operation capability.
export async function reapDirectDeletions(env: DirectDeletionEnv): Promise<number> {
  if (!env.AUTH_SERVICE) throw new Error('Auth service binding unavailable');
  const rows = await env.DB.prepare(
    'SELECT operation_hash FROM flaxia_direct_deletion_jobs ORDER BY last_checked, operation_hash LIMIT 20',
  ).all<{
    operation_hash: string;
  }>();
  let completed = 0;
  for (const row of rows.results ?? []) {
    if ((await resumeDirectDeletionHash(env, row.operation_hash)) === 'ok') completed++;
    else
      await env.DB.prepare(
        "UPDATE flaxia_direct_deletion_jobs SET last_checked = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_hash = ?",
      )
        .bind(row.operation_hash)
        .run();
  }
  return completed;
}
