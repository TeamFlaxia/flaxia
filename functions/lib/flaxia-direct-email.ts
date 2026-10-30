import { authEmailAction } from './flaxia-auth.ts';

type Result = 'ok' | 'none' | 'cancelled' | 'pending' | 'unavailable';

// Email is reserved in the application DB before Auth changes its authoritative
// copy. The operation hash is an identifier, not a bearer credential.
export async function resumeDirectEmailChange(
  env: Env,
  grant: string,
  userId: string,
  forceCancel = false,
): Promise<Result> {
  const authEnv = env as { AUTH_SERVICE?: Fetcher };
  try {
    const job = await env.DB.prepare(
      'SELECT operation_hash, target_email, state, created_at FROM flaxia_direct_email_changes WHERE user_id = ?',
    )
      .bind(userId)
      .first<{ operation_hash: string; target_email: string; state: string; created_at: string }>();
    if (!job) return 'none';
    const args = { operation_hash: job.operation_hash, grant, user_id: userId };
    const acknowledge = async (): Promise<Result> => {
      if ((await authEmailAction(authEnv, 'ack', args)).status !== 'ok') return 'unavailable';
      await env.DB.prepare(
        "DELETE FROM flaxia_direct_email_changes WHERE operation_hash = ? AND user_id = ? AND state = 'applied'",
      )
        .bind(job.operation_hash, userId)
        .run();
      return 'ok';
    };
    if (job.state === 'applied') return acknowledge();
    const status = await authEmailAction(authEnv, 'status', args);
    if (status.status === 'unavailable' || status.status === 'denied') return 'unavailable';
    if (status.status === 'missing') {
      if (!forceCancel && Date.parse(job.created_at) > Date.now() - 60_000) return 'pending';
      const cancelled = await authEmailAction(authEnv, 'cancel', args);
      if (cancelled.status === 'denied') return resumeDirectEmailChange(env, grant, userId);
      if (cancelled.status !== 'ok') return 'unavailable';
      await env.DB.prepare('DELETE FROM flaxia_direct_email_changes WHERE operation_hash = ? AND user_id = ?')
        .bind(job.operation_hash, userId)
        .run();
      return 'cancelled';
    }
    if (status.state === 'cancelled') {
      await env.DB.prepare('DELETE FROM flaxia_direct_email_changes WHERE operation_hash = ? AND user_id = ?')
        .bind(job.operation_hash, userId)
        .run();
      return 'cancelled';
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(job.target_email)));
    const targetHash = btoa(String.fromCharCode(...digest))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    if (status.state !== 'committed' || status.target_hash !== targetHash) return 'unavailable';
    const assertOne = () =>
      env.DB.prepare(
        'INSERT INTO flaxia_auth_transition_assertions (valid) VALUES (CASE WHEN changes() = 1 THEN 1 ELSE NULL END)',
      );
    const clear = () => env.DB.prepare('DELETE FROM flaxia_auth_transition_assertions');
    try {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE flaxia_direct_email_changes SET state = 'applying' WHERE operation_hash = ? AND state = 'pending'",
        ).bind(job.operation_hash),
        assertOne(),
        clear(),
        env.DB.prepare('UPDATE users SET email = ? WHERE id = ? AND frozen_at IS NULL').bind(job.target_email, userId),
        assertOne(),
        clear(),
        env.DB.prepare(
          "UPDATE flaxia_direct_email_changes SET state = 'applied' WHERE operation_hash = ? AND state = 'applying'",
        ).bind(job.operation_hash),
        assertOne(),
        clear(),
      ]);
    } catch {
      const remaining = await env.DB.prepare('SELECT 1 FROM flaxia_direct_email_changes WHERE operation_hash = ?')
        .bind(job.operation_hash)
        .first();
      return remaining ? 'unavailable' : 'ok';
    }
    return acknowledge();
  } catch {
    return 'unavailable';
  }
}
