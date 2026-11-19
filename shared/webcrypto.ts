/**
 * WebCrypto helpers shared by Pages Functions and the mail Worker.
 *
 * Both sides sign the same `x-flaxia-sig` contract (docs/mail.md §5), so the
 * primitives must not drift. Keep this module free of Cloudflare and Node
 * imports: it only uses WebCrypto, which both runtimes provide.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value) as BufferSource));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message) as BufferSource);
  return toHex(signature);
}

/** Length-independent byte compare so a wrong signature cannot be brute-forced by timing. */
export function signatureEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
