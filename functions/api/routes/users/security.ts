import { Hono } from 'hono';
import { isValidB64, isValidVaultKdfParams, isValidWrappedKey } from '../../../../shared/vault/primitives.ts';
import { getMeWithSession, getSessionToken, verifySrpPassword } from '../../../lib/auth';
import {
  authCredentialOperation,
  authEmailAction,
  authIsAuthoritative,
  credentialStampFor,
  hasPendingAuthProvision,
  sessionGrant,
} from '../../../lib/flaxia-auth';
import { cancelAuthCredentialChange, resumeAuthCredentialChange } from '../../../lib/flaxia-auth-credentials';
import { deletionOperationHash } from '../../../lib/flaxia-auth-deletion';
import { ensureAuthVault } from '../../../lib/flaxia-auth-vault';
import { resumeDirectCredentialChange } from '../../../lib/flaxia-direct-credentials';
import { resumeDirectEmailChange } from '../../../lib/flaxia-direct-email';
import { checkRateLimit } from '../../../lib/rate-limit';
import { isCreatableSrpKdf } from '../../../lib/srp';
import { requireAuth } from '../../helpers';
import type { Bindings, SrpProofBody, Variables } from '../../types';

export const security = new Hono<{ Bindings: Bindings; Variables: Variables }>();

security.patch('/users/me/email', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const sessionToken = getSessionToken(c.req.raw);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // A linked opt-in session is a local session id mapped to an Auth grant.
    // Direct authority sessions are already 43-character grants. Resolve both
    // before deciding whether the Auth email authority must be updated.
    const authGrant = await sessionGrant(c.env.DB, sessionToken);

    const { current_srp, new_email } = await c.req.json();

    if (typeof new_email !== 'string') {
      return c.json({ error: 'New email is required' }, 400);
    }
    const normalizedEmail = new_email.trim().toLowerCase();
    if (normalizedEmail.length === 0) {
      return c.json({ error: 'New email is required' }, 400);
    }
    if (normalizedEmail.length > 254) {
      return c.json({ error: 'Invalid email format' }, 400);
    }

    const proof = current_srp as SrpProofBody | undefined;
    if (!proof?.challenge_id || !proof.A || !proof.M1) {
      return c.json({ error: 'Current password proof is required' }, 400);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return c.json({ error: 'Invalid email format' }, 400);
    }

    const userId = user.id;

    // Email changes are authenticated and prove the password, but the
    // endpoint still needs its own throttle: a stolen session can otherwise
    // churn addresses without bound.
    const allowed = await checkRateLimit(c.env.CACHE, `users:email:${userId}`, {
      maxRequests: 5,
      windowSeconds: 60,
    });
    if (!allowed) {
      return c.json({ error: 'Too many requests. Please try again later.' }, 429);
    }

    if (authGrant) {
      const existing = await c.env.DB.prepare(
        'SELECT operation_hash, target_email FROM flaxia_direct_email_changes WHERE user_id = ?',
      )
        .bind(userId)
        .first<{ operation_hash: string; target_email: string }>();
      let operationHash: string;
      if (existing) {
        if (existing.target_email.toLowerCase() !== normalizedEmail)
          return c.json({ error: 'Email is already taken or a change is pending' }, 409);
        operationHash = existing.operation_hash;
      } else {
        operationHash = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replaceAll('=', '');
        await c.env.DB.prepare(`INSERT OR IGNORE INTO flaxia_direct_email_changes (operation_hash, user_id, target_email, state, created_at)
          SELECT ?, u.id, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM users u WHERE u.id = ? AND u.frozen_at IS NULL AND NOT EXISTS (SELECT 1 FROM users other WHERE lower(other.email) = ? AND other.id != u.id)`)
          .bind(operationHash, normalizedEmail, userId, normalizedEmail)
          .run();
        const job = await c.env.DB.prepare('SELECT operation_hash FROM flaxia_direct_email_changes WHERE user_id = ?')
          .bind(userId)
          .first<{ operation_hash: string }>();
        if (!job || job.operation_hash !== operationHash)
          return c.json({ error: 'Email is already taken or a change is pending' }, 409);
      }
      const remote = await authEmailAction(c.env, 'change', {
        operation_hash: operationHash,
        grant: authGrant,
        user_id: userId,
        email: normalizedEmail,
        current_srp: proof,
      });
      if (remote.status === 'unavailable') return c.json({ error: 'Email change temporarily unavailable' }, 503);
      if (remote.status === 'denied') {
        const result = await resumeDirectEmailChange(c.env, authGrant, userId, true);
        if (result === 'ok') return c.json({ ok: true });
        if (result === 'none') {
          const current = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?')
            .bind(userId)
            .first<{ email: string }>();
          return current?.email === normalizedEmail
            ? c.json({ ok: true })
            : c.json({ error: 'Email change rejected' }, 409);
        }
        if (result === 'cancelled') return c.json({ error: 'Email change rejected' }, 409);
        return c.json({ error: 'Email change temporarily unavailable' }, 503);
      }
      const result = await resumeDirectEmailChange(c.env, authGrant, userId);
      if (result === 'ok') return c.json({ ok: true });
      if (result === 'none') {
        const current = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?')
          .bind(userId)
          .first<{ email: string }>();
        if (current?.email === normalizedEmail) return c.json({ ok: true });
      }
      return c.json({ error: 'Email change temporarily unavailable' }, 503);
    }

    const isValid = await verifySrpPassword(
      c.env,
      userId,
      proof.challenge_id,
      proof.A,
      proof.M1,
      getSessionToken(c.req.raw),
    );
    if (!isValid) {
      return c.json({ error: 'Current password is incorrect' }, 401);
    }

    const existingEmail = await c.env.DB.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?')
      .bind(normalizedEmail, userId)
      .first();
    if (existingEmail) {
      return c.json({ error: 'Email is already taken' }, 409);
    }

    const result = await c.env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
      .bind(normalizedEmail, userId)
      .run();

    if (!result.success) {
      return c.json({ error: 'Failed to update email' }, 500);
    }

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Update email error:', error);
    return c.json({ error: 'Failed to update email' }, 500);
  }
});

security.post('/users/me/credentials/retry', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { operation?: unknown } | null;
  if (!body || typeof body.operation !== 'string') return c.json({ error: 'Invalid operation' }, 400);
  const token = getSessionToken(c.req.raw);
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const identity = await getMeWithSession(c.env, token);
    if (!identity) return c.json({ error: 'Unauthorized' }, 401);
    const result = await resumeDirectCredentialChange(c.env, body.operation, token, identity.user.id);
    if (result === 'ok') return c.json({ ok: true });
    if (result === 'cancelled') return c.json({ error: 'Credential change cancelled', cancelled: true }, 409);
    if (result === 'not_found') return c.json({ error: 'Operation not found' }, 404);
    return c.json({ error: 'Credential change temporarily unavailable' }, 503);
  }
  const result = await resumeAuthCredentialChange(c.env, body.operation);
  if (result === 'ok') return c.json({ ok: true });
  if (result === 'cancelled') return c.json({ error: 'Credential change cancelled', cancelled: true }, 409);
  if (result === 'not_found') return c.json({ error: 'Operation not found' }, 404);
  if (result === 'denied' || result === 'conflict') {
    const cancelled = await cancelAuthCredentialChange(c.env, body.operation);
    if (cancelled === 'cancelled')
      return c.json(
        {
          error: result === 'denied' ? 'Current password is incorrect' : 'vault_key_version_conflict',
          cancelled: true,
        },
        result === 'denied' ? 401 : 409,
      );
  }
  return c.json({ error: 'Credential change temporarily unavailable' }, 503);
});

// PATCH /users/me/password - update password (protected)
//
// Neither the current nor the new password is ever sent: the current one is
// proven via SRP, the new one arrives only as a verifier the client derived
// locally. `password_hash` is blanked unconditionally so the account stops
// carrying a value that a database dump could dictionary-attack outside the
// protocol.
security.patch('/users/me/password', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const sessionToken = getSessionToken(c.req.raw);
    const grant = await sessionGrant(c.env.DB, sessionToken);
    if (!grant && (await hasPendingAuthProvision(c.env.DB, user.id)))
      return c.json({ error: 'Credential changes unavailable during Auth migration' }, 409);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    const { srp_salt, srp_verifier, srp_group, srp_kdf, current_srp, vault_kek, operation, recovery } =
      await c.req.json();

    if (!srp_salt || !srp_verifier || !srp_group || !srp_kdf) {
      return c.json({ error: 'New SRP verifier required' }, 400);
    }
    if (srp_group !== '2048') return c.json({ error: 'Unsupported SRP group' }, 400);
    if (!isCreatableSrpKdf(srp_kdf)) return c.json({ error: 'Unsupported SRP KDF' }, 400);
    // Same shape checks as registration: a degenerate verifier would make the
    // account undecryptable / trivially attackable.
    if (!isValidB64(srp_salt, 16)) return c.json({ error: 'Invalid SRP salt' }, 400);
    if (!isValidB64(srp_verifier, 256)) return c.json({ error: 'Invalid SRP verifier' }, 400);

    const proof = current_srp as SrpProofBody | undefined;
    if (!proof?.challenge_id || !proof.A || !proof.M1) {
      return c.json({ error: 'Current password proof is required' }, 400);
    }

    const userId = user.id;

    if (!grant && !(await verifySrpPassword(c.env, userId, proof.challenge_id, proof.A, proof.M1, sessionToken))) {
      return c.json({ error: 'Current password is incorrect' }, 401);
    }

    // A vault exists ⇒ VK is wrapped under a KEK derived from the OLD password.
    // The client holds that password right now, so it must re-wrap VK in the
    // same request; otherwise the vault is orphaned the moment this lands.
    //
    // In authority mode Auth owns the envelope for every session, including a
    // local session id still mapped to an Auth grant. The transitional Flaxia
    // rows (if any) are copied to Auth first, and the rewrap travels in the
    // credential operation so Auth can apply verifier and envelope together.
    const authOwnsVault = Boolean(grant && authIsAuthoritative(c.env));
    const vaultState = authOwnsVault
      ? await ensureAuthVault(c.env, grant as string, userId)
      : await (async () => {
          const row = (await c.env.DB.prepare('SELECT vk_version FROM vault_keys WHERE user_id = ?')
            .bind(userId)
            .first()) as { vk_version: number } | null;
          return row ? { enabled: true, vk_version: row.vk_version } : { enabled: false, vk_version: 0 };
        })();
    if (authOwnsVault && !vaultState) return c.json({ error: 'Vault temporarily unavailable' }, 503);

    const vaultUpdate = await (async () => {
      if (!vaultState?.enabled) {
        if (vault_kek !== undefined) return { error: 'No vault is enabled' } as const;
        return null;
      }
      const rewrap = vault_kek as
        | { salt?: unknown; kdf_params?: unknown; wrapped_vk?: unknown; vk_version?: unknown }
        | undefined;
      if (!rewrap) return { error: 'vault_rewrap_required' } as const;
      if (!isValidB64(rewrap.salt, 16)) return { error: 'Invalid vault salt' } as const;
      if (!isValidVaultKdfParams(rewrap.kdf_params)) return { error: 'Unsupported vault KDF parameters' } as const;
      if (!isValidWrappedKey(rewrap.wrapped_vk)) return { error: 'Invalid wrapped vault key' } as const;
      if (!Number.isSafeInteger(rewrap.vk_version) || (rewrap.vk_version as number) < 1) {
        return { error: 'Invalid vault key version' } as const;
      }
      if (rewrap.vk_version !== vaultState.vk_version) return { error: 'vault_key_version_conflict' } as const;
      return {
        sql: authOwnsVault
          ? null
          : `UPDATE vault_keys SET salt = ?, kdf_params = ?, wrapped_vk = ?,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE user_id = ? AND vk_version = ?`,
        binds: [
          rewrap.salt as string,
          JSON.stringify(rewrap.kdf_params),
          rewrap.wrapped_vk as string,
          userId,
          rewrap.vk_version as number,
        ],
        version: rewrap.vk_version as number,
      } as const;
    })();
    if (vaultUpdate && 'error' in vaultUpdate) {
      const status =
        vaultUpdate.error === 'vault_rewrap_required' || vaultUpdate.error === 'vault_key_version_conflict' ? 409 : 400;
      return c.json({ error: vaultUpdate.error }, status);
    }
    const vaultKek =
      vaultUpdate && !('error' in vaultUpdate)
        ? {
            salt: vaultUpdate.binds[0],
            kdf_params: JSON.parse(vaultUpdate.binds[1]),
            wrapped_vk: vaultUpdate.binds[2],
            vk_version: vaultUpdate.version,
          }
        : undefined;

    if (sessionToken && /^[A-Za-z0-9_-]{43}$/.test(sessionToken)) {
      if (typeof operation !== 'string') return c.json({ error: 'Credential operation required' }, 400);
      const hash = await deletionOperationHash(operation);
      if (
        !hash ||
        typeof proof.challenge_id !== 'string' ||
        proof.challenge_id.length > 64 ||
        typeof proof.A !== 'string' ||
        proof.A.length > 400 ||
        typeof proof.M1 !== 'string' ||
        proof.M1.length > 64
      )
        return c.json({ error: 'Invalid credential operation' }, 400);
      const target = await credentialStampFor({ password_hash: '', srp_salt, srp_verifier, srp_group, srp_kdf });
      if (!target) return c.json({ error: 'Invalid credential operation' }, 400);
      const vaultJson = vaultKek ? JSON.stringify(vaultKek) : null;
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO flaxia_direct_vault_changes (operation_hash, user_id, target_stamp, vault_json, state, created_at) SELECT ?, id, ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM users WHERE id = ? AND frozen_at IS NULL",
      )
        .bind(hash, target.stamp, vaultJson, userId)
        .run();
      const job = await c.env.DB.prepare(
        'SELECT user_id, target_stamp, vault_json, state FROM flaxia_direct_vault_changes WHERE operation_hash = ?',
      )
        .bind(hash)
        .first<{ user_id: string; target_stamp: string; vault_json: string | null; state: string }>();
      if (!job || job.user_id !== userId || job.target_stamp !== target.stamp || job.vault_json !== vaultJson)
        return c.json({ error: 'Credential change already pending' }, 409);
      if (job.state === 'pending') {
        const prepared = await authCredentialOperation(
          c.env,
          'prepare',
          {
            operation,
            grant: sessionToken,
            user_id: userId,
            current_srp: proof,
            srp_salt,
            srp_verifier,
            srp_group,
            srp_kdf,
            recoverable: true,
            recovery: recovery === true,
            ...(vaultKek ? { vault_kek: vaultKek } : {}),
          },
          target.stamp,
        );
        if (prepared === 'unavailable') return c.json({ error: 'Credential change temporarily unavailable' }, 503);
        if (prepared === 'denied') {
          const cancelled = await resumeDirectCredentialChange(c.env, operation, sessionToken, userId);
          if (cancelled === 'cancelled')
            return c.json({ error: 'Current password is incorrect', cancelled: true }, 401);
          if (cancelled === 'ok') return c.json({ ok: true });
          return c.json({ error: 'Credential change temporarily unavailable' }, 503);
        }
      }
      const result = await resumeDirectCredentialChange(c.env, operation, sessionToken, userId);
      if (result === 'ok') return c.json({ ok: true });
      if (result === 'cancelled') return c.json({ error: 'Credential change cancelled', cancelled: true }, 409);
      return c.json({ error: 'Credential change temporarily unavailable' }, 503);
    }

    if (grant) {
      if (!sessionToken || typeof operation !== 'string')
        return c.json({ error: 'Credential operation required' }, 400);
      const hash = await deletionOperationHash(operation);
      if (
        !hash ||
        typeof proof.challenge_id !== 'string' ||
        proof.challenge_id.length > 64 ||
        typeof proof.A !== 'string' ||
        proof.A.length > 400 ||
        typeof proof.M1 !== 'string' ||
        proof.M1.length > 64
      )
        return c.json({ error: 'Invalid credential operation' }, 400);
      const target = await credentialStampFor({ password_hash: '', srp_salt, srp_verifier, srp_group, srp_kdf });
      if (!target) return c.json({ error: 'Invalid credential operation' }, 400);
      const vaultJson = vaultKek ? JSON.stringify(vaultKek) : null;
      await c.env.DB.prepare(`INSERT OR IGNORE INTO flaxia_auth_credential_jobs
        (operation_hash, operation_token, user_id, session_id, grant_token, proof_json, old_password_hash, old_salt, old_verifier, old_group, old_kdf, new_salt, new_verifier, new_group, new_kdf, target_stamp, vault_json, state)
        SELECT ?, ?, u.id, s.id, a.grant_token, ?, u.password_hash, u.srp_salt, u.srp_verifier, u.srp_group, u.srp_kdf, ?, ?, ?, ?, ?, ?, 'pending'
        FROM users u JOIN sessions s ON s.user_id = u.id JOIN flaxia_auth_sessions a ON a.session_id = s.id
        WHERE u.id = ? AND u.frozen_at IS NULL AND s.id = ? AND a.grant_token = ?
          AND NOT EXISTS (SELECT 1 FROM flaxia_auth_deletion_jobs WHERE user_id = u.id)`)
        .bind(
          hash,
          operation,
          JSON.stringify(proof),
          srp_salt,
          srp_verifier,
          srp_group,
          srp_kdf,
          target.stamp,
          vaultJson,
          userId,
          sessionToken,
          grant,
        )
        .run();
      const job = await c.env.DB.prepare(
        'SELECT user_id, session_id, grant_token, target_stamp, vault_json FROM flaxia_auth_credential_jobs WHERE operation_hash = ?',
      )
        .bind(hash)
        .first<{
          user_id: string;
          session_id: string | null;
          grant_token: string | null;
          target_stamp: string;
          vault_json: string | null;
        }>();
      if (
        !job ||
        job.user_id !== userId ||
        job.session_id !== sessionToken ||
        job.grant_token !== grant ||
        job.target_stamp !== target.stamp ||
        job.vault_json !== vaultJson
      )
        return c.json({ error: 'Credential change already pending' }, 409);
      const result = await resumeAuthCredentialChange(c.env, operation);
      if (result === 'ok') return c.json({ ok: true });
      if (result === 'denied' || result === 'conflict') {
        const cancelled = await cancelAuthCredentialChange(c.env, operation);
        if (cancelled === 'cancelled')
          return c.json(
            {
              error: result === 'denied' ? 'Current password is incorrect' : 'vault_key_version_conflict',
              cancelled: true,
            },
            result === 'denied' ? 401 : 409,
          );
      }
      return c.json({ error: 'Credential change temporarily unavailable' }, 503);
    }

    // password_hash is blanked unconditionally: the account must stop carrying
    // a value a dump could dictionary-attack outside the SRP protocol.
    const expectedVaultVersion = vaultUpdate && vaultUpdate.sql ? vaultUpdate.version : null;
    const statements = [
      c.env.DB.prepare(
        `UPDATE users SET password_hash = '', srp_salt = ?, srp_verifier = ?, srp_group = ?, srp_kdf = ?
         WHERE id = ? AND (
           (? IS NULL AND NOT EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ?))
           OR EXISTS (SELECT 1 FROM vault_keys WHERE user_id = ? AND vk_version = ?)
         )`,
      ).bind(
        srp_salt,
        srp_verifier,
        srp_group,
        srp_kdf,
        userId,
        expectedVaultVersion,
        userId,
        userId,
        expectedVaultVersion,
      ),
    ];
    if (vaultUpdate?.sql) {
      statements.push(c.env.DB.prepare(vaultUpdate.sql).bind(...vaultUpdate.binds));
    }
    // Revoke other sessions in the same transaction. changes() refers to the
    // preceding credential/envelope update, so a version conflict cannot log
    // out devices and a storage failure rolls back the credential change.
    statements.push(
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ? AND changes() = 1').bind(
        userId,
        getSessionToken(c.req.raw) ?? '',
      ),
    );
    // batch() is atomic: the vault must never end up pointing at a KEK the new
    // password cannot derive, or vice versa.
    const results = await c.env.DB.batch(statements);
    if (results.some((r) => !r.success)) {
      return c.json({ error: 'Failed to update password' }, 500);
    }
    if (results[0].meta.changes === 0) return c.json({ error: 'vault_key_version_conflict' }, 409);

    return c.json({ ok: true });
  } catch (error: unknown) {
    console.error('Update password error:', error);
    return c.json({ error: 'Failed to update password' }, 500);
  }
});

// The browser keeps the operation capability before deletion begins, so a
// lost response can be retried even after Auth has revoked the session.
