import { authCredentialOperation, authCredentialStatus, cancelAuthCredentialHash } from './flaxia-auth.ts';
import { deletionOperationHash } from './flaxia-auth-deletion.ts';

type Job = {
  user_id: string;
  target_stamp: string;
  vault_json: string | null;
  state: 'pending' | 'prepared' | 'applying' | 'local_committed' | 'committed' | 'cancelling' | 'cancelled';
};
type Result = 'ok' | 'cancelled' | 'conflict' | 'not_found' | 'unavailable';

export async function cancelStaleDirectCredentialChange(env: Env, grant: string, userId: string): Promise<boolean> {
  try {
    const job = await env.DB.prepare(
      "SELECT operation_hash FROM flaxia_direct_vault_changes WHERE user_id = ? AND state IN ('pending', 'cancelling') AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')",
    )
      .bind(userId)
      .first<{ operation_hash: string }>();
    if (!job) return true;
    await env.DB.prepare(
      "UPDATE flaxia_direct_vault_changes SET state = 'cancelling' WHERE operation_hash = ? AND state = 'pending'",
    )
      .bind(job.operation_hash)
      .run();
    const locked = await env.DB.prepare(
      "SELECT 1 FROM flaxia_direct_vault_changes WHERE operation_hash = ? AND state = 'cancelling'",
    )
      .bind(job.operation_hash)
      .first();
    if (!locked) return true;
    if (!(await cancelAuthCredentialHash(env as { AUTH_SERVICE?: Fetcher }, job.operation_hash, grant, userId)))
      return false;
    await env.DB.prepare(
      "UPDATE flaxia_direct_vault_changes SET state = 'cancelled', vault_json = NULL, target_stamp = '' WHERE operation_hash = ? AND state = 'cancelling'",
    )
      .bind(job.operation_hash)
      .run();
    return true;
  } catch {
    return false;
  }
}

// Auth retains the verifier and grant. Flaxia retains only encrypted Vault
// material and an operation hash; retries require the browser's grant and token.
export async function resumeDirectCredentialChange(
  env: Env,
  operation: string,
  grant: string,
  userId: string,
): Promise<Result> {
  const hash = await deletionOperationHash(operation);
  if (!hash) return 'not_found';
  const authEnv = env as { AUTH_SERVICE?: Fetcher };
  const args = { operation, grant, user_id: userId };
  const acknowledge = async (): Promise<Result> =>
    (await authCredentialOperation(authEnv, 'ack', args)) === 'ok' ? 'ok' : 'unavailable';
  const read = () =>
    env.DB.prepare('SELECT * FROM flaxia_direct_vault_changes WHERE operation_hash = ? AND user_id = ?')
      .bind(hash, userId)
      .first<Job>();
  try {
    let job = await read();
    if (!job) return 'not_found';
    if (job.state === 'committed') return acknowledge();
    if (job.state === 'cancelled') return 'cancelled';
    if (job.state === 'pending') {
      const status = await authCredentialStatus(authEnv, args);
      if (status === 'unavailable') return 'unavailable';
      if (status === 'not_found' || status.state === 'cancelled') {
        // A cancellation tombstone also prevents a delayed prepare request
        // from starting after this operation has been discarded locally.
        await env.DB.prepare(
          "UPDATE flaxia_direct_vault_changes SET state = 'cancelling' WHERE operation_hash = ? AND state = 'pending'",
        )
          .bind(hash)
          .run();
        job = await read();
        if (!job) return 'not_found';
      } else {
        if (status.state !== 'prepared' || status.target_stamp !== job.target_stamp) return 'conflict';
        await env.DB.prepare(
          "UPDATE flaxia_direct_vault_changes SET state = 'prepared' WHERE operation_hash = ? AND state = 'pending'",
        )
          .bind(hash)
          .run();
        job = await read();
        if (!job) return 'not_found';
      }
    }
    if (job.state === 'cancelling') {
      if ((await authCredentialOperation(authEnv, 'cancel', args)) !== 'ok') return 'unavailable';
      await env.DB.prepare(
        "UPDATE flaxia_direct_vault_changes SET state = 'cancelled', vault_json = NULL, target_stamp = '' WHERE operation_hash = ? AND state = 'cancelling'",
      )
        .bind(hash)
        .run();
      return 'cancelled';
    }
    if (job.state === 'prepared') {
      const vault = job.vault_json
        ? (JSON.parse(job.vault_json) as { salt: string; kdf_params: unknown; wrapped_vk: string; vk_version: number })
        : null;
      const assertOne = () =>
        env.DB.prepare(
          'INSERT INTO flaxia_auth_transition_assertions (valid) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE NULL END)',
        );
      const clear = () => env.DB.prepare('DELETE FROM flaxia_auth_transition_assertions');
      const statements = [
        env.DB.prepare(
          "UPDATE flaxia_direct_vault_changes SET state = 'applying' WHERE operation_hash = ? AND state = 'prepared' AND EXISTS (SELECT 1 FROM users WHERE id = flaxia_direct_vault_changes.user_id AND frozen_at IS NULL)",
        ).bind(hash),
        assertOne(),
        clear(),
        vault
          ? env.DB.prepare(
              "UPDATE vault_keys SET salt = ?, kdf_params = ?, wrapped_vk = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND vk_version = ?",
            ).bind(vault.salt, JSON.stringify(vault.kdf_params), vault.wrapped_vk, userId, vault.vk_version)
          : env.DB.prepare(
              'UPDATE flaxia_direct_vault_changes SET state = state WHERE operation_hash = ? AND NOT EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ?)',
            ).bind(hash, userId),
        assertOne(),
        clear(),
        env.DB.prepare(
          "UPDATE flaxia_direct_vault_changes SET state = 'local_committed' WHERE operation_hash = ? AND state = 'applying'",
        ).bind(hash),
        assertOne(),
        clear(),
      ];
      try {
        await env.DB.batch(statements);
      } catch {
        // The failed batch is atomic. Only cancel if no competing request has
        // already advanced it; cancellation is also atomic at Auth.
        await env.DB.prepare(
          "UPDATE flaxia_direct_vault_changes SET state = 'cancelling' WHERE operation_hash = ? AND state = 'prepared'",
        )
          .bind(hash)
          .run();
        const latest = await read();
        if (!latest) return 'not_found';
        if (latest.state === 'cancelling' || latest.state === 'local_committed' || latest.state === 'committed')
          return resumeDirectCredentialChange(env, operation, grant, userId);
        return 'conflict';
      }
      job = await read();
      if (!job) return 'not_found';
    }
    if (job.state === 'committed') return acknowledge();
    if (job.state !== 'local_committed') return 'unavailable';
    if ((await authCredentialOperation(authEnv, 'commit', args, job.target_stamp)) !== 'ok') return 'unavailable';
    await env.DB.prepare(
      "UPDATE flaxia_direct_vault_changes SET state = 'committed', vault_json = NULL, target_stamp = '' WHERE operation_hash = ? AND state = 'local_committed'",
    )
      .bind(hash)
      .run();
    return acknowledge();
  } catch {
    return 'unavailable';
  }
}
