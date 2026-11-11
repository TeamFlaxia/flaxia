/// <reference types="@cloudflare/workers-types" />

import { exportPrivateKey, exportPublicKey, generateKeyPair } from './crypto.ts';

/**
 * The key pair of a local actor.
 *
 * The key is created when it is needed for the first time: an account that
 * never federated has no key yet. Concurrent requests must never replace a
 * published key, so the row is only inserted once.
 */
export async function ensureActorKey(db: D1Database, userId: string): Promise<string> {
  const existing = await db
    .prepare('SELECT public_key_pem FROM actor_keys WHERE user_id = ?')
    .bind(userId)
    .first<{ public_key_pem: string }>();
  if (existing?.public_key_pem) return existing.public_key_pem;

  const keyPair = await generateKeyPair();
  const publicKeyPem = await exportPublicKey(keyPair.publicKey);
  const privateKeyPem = await exportPrivateKey(keyPair.privateKey);

  await db
    .prepare(
      `INSERT OR IGNORE INTO actor_keys (user_id, public_key_pem, private_key_pem, created_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(userId, publicKeyPem, privateKeyPem)
    .run();

  const stored = await db
    .prepare('SELECT public_key_pem FROM actor_keys WHERE user_id = ?')
    .bind(userId)
    .first<{ public_key_pem: string }>();
  if (!stored) throw new Error('Actor key could not be initialized');
  return stored.public_key_pem;
}

/**
 * The options that sign a request with the key of a local actor.
 *
 * An instance that runs in secure mode only answers a signed request, so
 * every request to a remote instance is signed with the key of the account
 * that federates with it.
 */
export async function actorSignOptions(
  db: D1Database,
  baseUrl: string,
  username: string,
): Promise<{ privateKeyPem: string; keyId: string } | Record<string, never>> {
  const key = await db
    .prepare(
      `SELECT ak.private_key_pem FROM actor_keys ak JOIN users u ON u.id = ak.user_id
     WHERE u.username = ? COLLATE NOCASE`,
    )
    .bind(username)
    .first<{ private_key_pem: string }>();
  if (!key?.private_key_pem) return {};
  return { privateKeyPem: key.private_key_pem, keyId: `${baseUrl}/api/actors/${username}#main-key` };
}

/** The private key of a local actor, when it exists. */
export async function actorPrivateKey(db: D1Database, userId: string): Promise<string | null> {
  const key = await db
    .prepare('SELECT private_key_pem FROM actor_keys WHERE user_id = ?')
    .bind(userId)
    .first<{ private_key_pem: string }>();
  return key?.private_key_pem ?? null;
}
