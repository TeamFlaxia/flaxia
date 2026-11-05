import { authCredentialOperation, authIsAuthoritative } from './flaxia-auth.ts';
import { deletionOperationHash } from './flaxia-auth-deletion.ts';

type Job = {
  user_id: string;
  session_id: string | null;
  grant_token: string | null;
  proof_json: string | null;
  old_password_hash: string | null;
  old_salt: string | null;
  old_verifier: string | null;
  old_group: string | null;
  old_kdf: string | null;
  new_salt: string | null;
  new_verifier: string | null;
  new_group: string | null;
  new_kdf: string | null;
  target_stamp: string;
  vault_json: string | null;
  state: 'pending' | 'prepared' | 'applying' | 'local_committed' | 'committed' | 'cancelling' | 'cancelled';
};
type Result = 'ok' | 'denied' | 'unavailable' | 'not_found' | 'conflict' | 'cancelled';

async function getJob(db: D1Database, hash: string): Promise<Job | null> {
  return db.prepare('SELECT * FROM flaxia_auth_credential_jobs WHERE operation_hash = ?').bind(hash).first<Job>();
}

export async function cancelAuthCredentialChange(env: Env, operation: string): Promise<Result> {
  const hash = await deletionOperationHash(operation);
  if (!hash) return 'not_found';
  try {
    await env.DB.prepare(
      "UPDATE flaxia_auth_credential_jobs SET state = 'cancelling' WHERE operation_hash = ? AND state IN ('pending', 'prepared')",
    )
      .bind(hash)
      .run();
    const job = await getJob(env.DB, hash);
    if (!job) return 'not_found';
    if (job.state === 'cancelled') return 'cancelled';
    if (job.state !== 'cancelling' || !job.grant_token) return 'conflict';
    const result = await authCredentialOperation(env as { AUTH_SERVICE?: Fetcher }, 'cancel', {
      operation,
      grant: job.grant_token,
      user_id: job.user_id,
    });
    if (result !== 'ok') return result;
    await env.DB.prepare(
      "UPDATE flaxia_auth_credential_jobs SET state = 'cancelled', operation_token = NULL, session_id = NULL, grant_token = NULL, proof_json = NULL, old_password_hash = NULL, old_salt = NULL, old_verifier = NULL, old_group = NULL, old_kdf = NULL, new_salt = NULL, new_verifier = NULL, new_group = NULL, new_kdf = NULL, vault_json = NULL WHERE operation_hash = ? AND state = 'cancelling'",
    )
      .bind(hash)
      .run();
    return 'cancelled';
  } catch {
    return 'unavailable';
  }
}

export async function resumeAuthCredentialChange(env: Env, operation: string): Promise<Result> {
  const hash = await deletionOperationHash(operation);
  if (!hash) return 'not_found';
  try {
    let job = await getJob(env.DB, hash);
    if (!job) return 'not_found';
    if (job.state === 'committed') return 'ok';
    if (job.state === 'cancelled') return 'cancelled';
    if (job.state === 'cancelling') return cancelAuthCredentialChange(env, operation);
    if (
      !job.grant_token ||
      !job.session_id ||
      !job.new_salt ||
      !job.new_verifier ||
      !job.new_group ||
      !job.new_kdf ||
      !job.proof_json
    )
      return 'unavailable';
    // In authority mode Auth owns the envelope even for a local session id that
    // is still mapped to an Auth grant. The rewrap has to travel with the
    // verifier in the same Auth transaction; the transitional local row is
    // never touched.
    const authOwnsVault = authIsAuthoritative(env as { AUTH_AUTHORITY_MODE?: string });
    const storedVault = job.vault_json
      ? (JSON.parse(job.vault_json) as { salt: string; kdf_params: unknown; wrapped_vk: string; vk_version: number })
      : null;
    if (job.state === 'pending') {
      const result = await authCredentialOperation(
        env as { AUTH_SERVICE?: Fetcher },
        'prepare',
        {
          operation,
          grant: job.grant_token,
          user_id: job.user_id,
          current_srp: JSON.parse(job.proof_json),
          srp_salt: job.new_salt,
          srp_verifier: job.new_verifier,
          srp_group: job.new_group,
          srp_kdf: job.new_kdf,
          ...(authOwnsVault && storedVault ? { vault_kek: storedVault } : {}),
        },
        job.target_stamp,
      );
      if (result !== 'ok') return result;
      await env.DB.prepare(
        "UPDATE flaxia_auth_credential_jobs SET state = 'prepared' WHERE operation_hash = ? AND state = 'pending'",
      )
        .bind(hash)
        .run();
      job = await getJob(env.DB, hash);
      if (!job) return 'not_found';
      if (job.state === 'cancelling') return cancelAuthCredentialChange(env, operation);
      if (job.state === 'cancelled') return 'cancelled';
    }
    if (job.state === 'prepared') {
      // Auth applies the rewrap for preserved accounts, so the local envelope
      // is only rewritten while Flaxia still owns it. Once Auth is
      // authoritative a leftover transitional row is inert and must not make
      // the credential change depend on its version.
      const vault = authOwnsVault ? null : storedVault;
      const vaultGuard = authOwnsVault
        ? '1 = 1'
        : '((? IS NULL AND NOT EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ?)) OR EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ? AND vk_version = ?))';
      const assertion = () =>
        env.DB.prepare(
          'INSERT INTO flaxia_auth_transition_assertions (valid) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE NULL END)',
        );
      const clearAssertion = () => env.DB.prepare('DELETE FROM flaxia_auth_transition_assertions');
      const userUpdate =
        env.DB.prepare(`UPDATE users SET password_hash = '', srp_salt = ?, srp_verifier = ?, srp_group = ?, srp_kdf = ?
          WHERE id = ? AND frozen_at IS NULL AND password_hash IS ? AND srp_salt IS ? AND srp_verifier IS ? AND srp_group IS ? AND srp_kdf IS ?
          AND EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs WHERE operation_hash = ? AND state = 'applying')
          AND EXISTS (SELECT 1 FROM flaxia_auth_sessions WHERE session_id = ? AND grant_token = ?)
          AND ${vaultGuard}`).bind(
          job.new_salt,
          job.new_verifier,
          job.new_group,
          job.new_kdf,
          job.user_id,
          job.old_password_hash,
          job.old_salt,
          job.old_verifier,
          job.old_group,
          job.old_kdf,
          hash,
          job.session_id,
          job.grant_token,
          ...(authOwnsVault ? [] : [vault?.vk_version ?? null, job.user_id, job.user_id, vault?.vk_version ?? null]),
        );
      const statements = [
        env.DB.prepare(
          "UPDATE flaxia_auth_credential_jobs SET state = 'applying' WHERE operation_hash = ? AND state = 'prepared'",
        ).bind(hash),
        assertion(),
        clearAssertion(),
        userUpdate,
        assertion(),
        clearAssertion(),
      ];
      if (vault) {
        statements.push(
          env.DB.prepare(
            "UPDATE vault_keys SET salt = ?, kdf_params = ?, wrapped_vk = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND vk_version = ?",
          ).bind(vault.salt, JSON.stringify(vault.kdf_params), vault.wrapped_vk, job.user_id, vault.vk_version),
          assertion(),
          clearAssertion(),
        );
      }
      statements.push(
        env.DB.prepare(
          'UPDATE flaxia_auth_sessions SET auth_stamp = ?, source_stamp = ? WHERE session_id = ? AND grant_token = ?',
        ).bind(job.target_stamp, job.target_stamp, job.session_id, job.grant_token),
        assertion(),
        clearAssertion(),
        env.DB.prepare(
          "UPDATE flaxia_auth_credential_jobs SET state = 'local_committed' WHERE operation_hash = ? AND state = 'applying'",
        ).bind(hash),
        assertion(),
        clearAssertion(),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(job.user_id, job.session_id),
      );
      try {
        await env.DB.batch(statements);
      } catch {
        // A concurrent request may have completed this transition first.
        const latest = await getJob(env.DB, hash);
        if (!latest) return 'not_found';
        if (latest.state === 'prepared') {
          const current = await env.DB.prepare(
            'SELECT password_hash, srp_salt, srp_verifier, srp_group, srp_kdf, frozen_at FROM users WHERE id = ?',
          )
            .bind(job.user_id)
            .first<{
              password_hash: string | null;
              srp_salt: string | null;
              srp_verifier: string | null;
              srp_group: string | null;
              srp_kdf: string | null;
              frozen_at: string | null;
            }>();
          const currentVault = await env.DB.prepare('SELECT vk_version FROM vault_keys WHERE user_id = ?')
            .bind(job.user_id)
            .first<{ vk_version: number }>();
          const mapping = await env.DB.prepare(
            'SELECT 1 FROM flaxia_auth_sessions WHERE session_id = ? AND grant_token = ?',
          )
            .bind(job.session_id, job.grant_token)
            .first();
          const unchanged =
            current &&
            !current.frozen_at &&
            current.password_hash === job.old_password_hash &&
            current.srp_salt === job.old_salt &&
            current.srp_verifier === job.old_verifier &&
            current.srp_group === job.old_group &&
            current.srp_kdf === job.old_kdf &&
            (currentVault?.vk_version ?? null) === (vault?.vk_version ?? null) &&
            mapping;
          return unchanged ? 'unavailable' : 'conflict';
        }
      }
      job = await getJob(env.DB, hash);
      if (!job) return 'not_found';
    }
    if (job.state === 'committed') return 'ok';
    if (job.state === 'cancelled') return 'cancelled';
    if (job.state === 'cancelling') return cancelAuthCredentialChange(env, operation);
    if (job.state !== 'local_committed' || !job.grant_token) return 'unavailable';
    const result = await authCredentialOperation(
      env as { AUTH_SERVICE?: Fetcher },
      'commit',
      { operation, grant: job.grant_token, user_id: job.user_id },
      job.target_stamp,
    );
    if (result !== 'ok') return result;
    await env.DB.prepare(
      "UPDATE flaxia_auth_credential_jobs SET state = 'committed', operation_token = NULL, session_id = NULL, grant_token = NULL, proof_json = NULL, old_password_hash = NULL, old_salt = NULL, old_verifier = NULL, old_group = NULL, old_kdf = NULL, new_salt = NULL, new_verifier = NULL, new_group = NULL, new_kdf = NULL, vault_json = NULL WHERE operation_hash = ? AND state = 'local_committed'",
    )
      .bind(hash)
      .run();
    return 'ok';
  } catch {
    return 'unavailable';
  }
}
