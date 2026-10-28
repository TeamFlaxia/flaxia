import type { Bindings } from '../api/types';

// This is a server-to-server request; the verifier and signing key never pass
// through the browser. A later successful login retries a failed transfer.
export async function syncLegacySrp(env: Bindings, userId: string): Promise<void> {
  const secret = env.LEGACY_SYNC_SECRET;
  if (!secret || secret.length < 32) return;
  const user = await env.DB.prepare(
    'SELECT id, srp_salt, srp_verifier, srp_group, srp_kdf FROM users WHERE id = ? AND frozen_at IS NULL',
  )
    .bind(userId)
    .first<{
      id: string;
      srp_salt: string | null;
      srp_verifier: string | null;
      srp_group: string | null;
      srp_kdf: string | null;
    }>();
  if (!user?.srp_salt || !user.srp_verifier || user.srp_group !== '2048' || user.srp_kdf !== 'pbkdf2-600k-v2') return;
  const body = JSON.stringify({
    user_id: user.id,
    salt: user.srp_salt,
    verifier: user.srp_verifier,
    group: user.srp_group,
    kdf: user.srp_kdf,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  const signature = btoa(String.fromCharCode(...mac))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const response = await fetch('https://auth.flaxia.app/api/internal/legacy-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Flaxia-Timestamp': timestamp, 'X-Flaxia-Signature': signature },
    body,
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('Auth migration sync failed');
}
