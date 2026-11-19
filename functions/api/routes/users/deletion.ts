import { Hono } from 'hono';
import { deleteAccount } from '../../../lib/account-deletion';
import { clearSessionCookie, deleteSession, getSessionToken, verifySrpPassword } from '../../../lib/auth';
import { cancelAuthDeletion, deleteAuthAccount, hasPendingAuthProvision, sessionGrant } from '../../../lib/flaxia-auth';
import {
  deletionOperationHash,
  resumeAuthDeletion,
  settleDeletionTransitions,
} from '../../../lib/flaxia-auth-deletion';
import { resumeDirectDeletion } from '../../../lib/flaxia-direct-deletion';
import { requireAuth } from '../../helpers';
import type { Bindings, SrpProofBody, Variables } from '../../types';

export const deletion = new Hono<{ Bindings: Bindings; Variables: Variables }>();

deletion.post('/users/me/deletion/retry', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { operation?: unknown } | null;
  if (!body || typeof body.operation !== 'string') return c.json({ error: 'Invalid operation' }, 400);
  const direct = await resumeDirectDeletion(c.env, body.operation);
  if (direct === 'ok') {
    const response = c.json({ success: true });
    clearSessionCookie(response);
    return response;
  }
  if (direct !== 'not_found') return c.json({ error: 'Deletion temporarily unavailable' }, 503);
  const result = await resumeAuthDeletion(c.env, body.operation);
  if (result === 'not_found') return c.json({ error: 'Operation not found' }, 404);
  if (result === 'denied') return c.json({ error: 'Current password proof rejected' }, 401);
  if (result !== 'ok') return c.json({ error: 'Deletion temporarily unavailable' }, 503);
  const response = c.json({ success: true });
  clearSessionCookie(response);
  return response;
});

// DELETE /users/me - delete current user account (protected)
deletion.delete('/users/me', requireAuth, async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const sessionToken = getSessionToken(c.req.raw);
    const grant = await sessionGrant(c.env.DB, sessionToken);
    if (!grant && (await hasPendingAuthProvision(c.env.DB, user.id)))
      return c.json({ error: 'Auth login required for account deletion' }, 409);

    if (!c.env.DB) {
      return c.json({ error: 'Database not available' }, 500);
    }

    // Irreversible and session-cookie-sufficient otherwise: require the same
    // SRP proof of the current password as email/password changes, so a
    // stolen session alone cannot destroy the account.
    const { current_srp, operation } = (await c.req.json().catch(() => ({}))) as {
      current_srp?: SrpProofBody;
      operation?: unknown;
    };
    if (!current_srp?.challenge_id || !current_srp.A || !current_srp.M1) {
      return c.json({ error: 'Current password proof is required' }, 400);
    }
    const userId = user.id;

    // An unfinished email or credential/vault change would trip a local guard
    // before the deletion job can be written. Settle them first; a valid
    // deletion proof means Auth still has the identity and nothing was deleted.
    const deletionGrant = sessionToken && /^[A-Za-z0-9_-]{43}$/.test(sessionToken) ? sessionToken : grant;
    if (deletionGrant) {
      if (typeof operation !== 'string') return c.json({ error: 'Deletion operation required' }, 400);
      if ((await settleDeletionTransitions(c.env, deletionGrant, userId)) !== 'ok')
        return c.json({ error: 'Deletion temporarily unavailable' }, 503);
    }

    if (sessionToken && /^[A-Za-z0-9_-]{43}$/.test(sessionToken)) {
      if (typeof operation !== 'string') return c.json({ error: 'Deletion operation required' }, 400);
      const hash = await deletionOperationHash(operation);
      if (
        !hash ||
        typeof current_srp.challenge_id !== 'string' ||
        current_srp.challenge_id.length > 64 ||
        typeof current_srp.A !== 'string' ||
        current_srp.A.length > 400 ||
        typeof current_srp.M1 !== 'string' ||
        current_srp.M1.length > 64
      )
        return c.json({ error: 'Invalid password proof' }, 400);
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO flaxia_direct_deletion_jobs (operation_hash, user_id, state) VALUES (?, ?, 'pending')",
      )
        .bind(hash, userId)
        .run();
      const job = await c.env.DB.prepare('SELECT user_id FROM flaxia_direct_deletion_jobs WHERE operation_hash = ?')
        .bind(hash)
        .first<{ user_id: string }>();
      if (!job || job.user_id !== userId) return c.json({ error: 'Deletion already pending' }, 409);
      const remote = await deleteAuthAccount(c.env, operation, sessionToken, userId, {
        challenge_id: current_srp.challenge_id,
        A: current_srp.A,
        M1: current_srp.M1,
      });
      if (remote === 'denied') {
        if (await cancelAuthDeletion(c.env, hash, sessionToken, userId)) {
          await c.env.DB.prepare(
            "DELETE FROM flaxia_direct_deletion_jobs WHERE operation_hash = ? AND user_id = ? AND state = 'pending'",
          )
            .bind(hash, userId)
            .run();
          return c.json({ error: 'Current password proof rejected', cancelled: true }, 401);
        }
        if ((await resumeDirectDeletion(c.env, operation)) === 'ok') {
          const response = c.json({ success: true });
          clearSessionCookie(response);
          return response;
        }
        return c.json({ error: 'Deletion temporarily unavailable' }, 503);
      }
      if (remote !== 'ok') return c.json({ error: 'Deletion temporarily unavailable' }, 503);
      if ((await resumeDirectDeletion(c.env, operation)) !== 'ok')
        return c.json({ error: 'Deletion temporarily unavailable' }, 503);
      const response = c.json({ success: true });
      clearSessionCookie(response);
      return response;
    }
    if (grant) {
      if (typeof operation !== 'string') return c.json({ error: 'Deletion operation required' }, 400);
      const hash = await deletionOperationHash(operation);
      if (!hash) return c.json({ error: 'Invalid deletion operation' }, 400);
      if (
        typeof current_srp.challenge_id !== 'string' ||
        current_srp.challenge_id.length > 64 ||
        typeof current_srp.A !== 'string' ||
        current_srp.A.length > 400 ||
        typeof current_srp.M1 !== 'string' ||
        current_srp.M1.length > 64
      )
        return c.json({ error: 'Invalid password proof' }, 400);
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO flaxia_auth_deletion_jobs (operation_hash, user_id, grant_token, proof_json, state) SELECT ?, ?, ?, ?, 'pending' WHERE NOT EXISTS (SELECT 1 FROM flaxia_auth_credential_jobs WHERE user_id = ? AND state NOT IN ('committed', 'cancelled'))",
      )
        .bind(hash, userId, grant, JSON.stringify(current_srp), userId)
        .run();
      const job = await c.env.DB.prepare(
        'SELECT user_id, grant_token, state FROM flaxia_auth_deletion_jobs WHERE operation_hash = ?',
      )
        .bind(hash)
        .first<{ user_id: string; grant_token: string; state: string }>();
      if (!job || job.user_id !== userId || job.grant_token !== grant)
        return c.json({ error: 'Deletion already pending' }, 409);
      if (job.state === 'pending')
        await c.env.DB.prepare(
          "UPDATE flaxia_auth_deletion_jobs SET proof_json = ? WHERE operation_hash = ? AND user_id = ? AND state = 'pending'",
        )
          .bind(JSON.stringify(current_srp), hash, userId)
          .run();
      const result = await resumeAuthDeletion(c.env, operation);
      if (result === 'denied') return c.json({ error: 'Current password proof rejected' }, 401);
      if (result !== 'ok') return c.json({ error: 'Deletion temporarily unavailable' }, 503);
      const response = c.json({ success: true });
      clearSessionCookie(response);
      return response;
    }
    if (
      !(await verifySrpPassword(
        c.env,
        userId,
        current_srp.challenge_id,
        current_srp.A,
        current_srp.M1,
        getSessionToken(c.req.raw),
      ))
    ) {
      return c.json({ error: 'Current password is incorrect' }, 401);
    }

    await deleteAccount(c.env, userId);

    const token = getSessionToken(c.req.raw);
    if (token) {
      await deleteSession(c.env, token);
    }

    return c.json({ success: true });
  } catch (error: unknown) {
    console.error('Delete account error:', error);
    return c.json({ error: 'Failed to delete account' }, 500);
  }
});

// POST /users/me/avatar - upload avatar (protected)
