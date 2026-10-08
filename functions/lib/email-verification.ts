import type { Bindings } from '../api/types';

export type EmailVerificationPurpose = 'registration' | 'email_change';

type VerificationRequest = {
  purpose: EmailVerificationPurpose;
  userId: string;
  email: string;
};

type VerificationTokenRow = {
  purpose: EmailVerificationPurpose;
  user_id: string;
  candidate_email: string;
};

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TEST_OUTBOX = new Map<string, string[]>();

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hasSafeVerificationBaseUrl(env: Bindings): boolean {
  try {
    const baseUrl = new URL(env.BASE_URL || 'https://flaxia.app');
    const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
    return (
      !baseUrl.username &&
      !baseUrl.password &&
      !baseUrl.search &&
      !baseUrl.hash &&
      (baseUrl.protocol === 'https:' || (baseUrl.protocol === 'http:' && isLoopback))
    );
  } catch {
    return false;
  }
}

export function isEmailDeliveryConfigured(env: Bindings): boolean {
  return hasSafeVerificationBaseUrl(env) && (env.ENVIRONMENT === 'test' || !!env.RESEND_API_KEY);
}

function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getVerificationUrl(env: Bindings, token: string): string {
  const baseUrl = new URL(env.BASE_URL || 'https://flaxia.app');
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLoopback))
  ) {
    throw new Error('Invalid verification base URL');
  }
  return new URL(`/verify-email?token=${encodeURIComponent(token)}`, baseUrl.origin).toString();
}

function rememberTestEmail(email: string, url: string): void {
  const key = normalizeEmail(email);
  const links = TEST_OUTBOX.get(key) ?? [];
  links.push(url);
  TEST_OUTBOX.set(key, links);
}

/** Test-only email mock retrieval; exposed through the separately guarded test router. */
export function takeTestVerificationLink(email: string): string | null {
  const key = normalizeEmail(email);
  const links = TEST_OUTBOX.get(key);
  if (!links?.length) return null;
  const link = links.shift() ?? null;
  if (links.length === 0) TEST_OUTBOX.delete(key);
  return link;
}

/** Clear ephemeral test deliveries when the integration-test database is reset. */
export function clearTestVerificationOutbox(): void {
  TEST_OUTBOX.clear();
}

export async function sendVerificationEmail(
  env: Bindings,
  email: string,
  purpose: EmailVerificationPurpose,
  url: string,
): Promise<boolean> {
  if (env.ENVIRONMENT === 'test') {
    rememberTestEmail(email, url);
    return true;
  }
  if (!env.RESEND_API_KEY) return false;

  const subject =
    purpose === 'registration'
      ? 'Verify your Flaxia email address / Flaxiaのメールアドレス認証'
      : 'Confirm your Flaxia email address change / Flaxiaのメールアドレス変更確認';
  const action = purpose === 'registration' ? 'verify your email address' : 'confirm your new email address';
  const actionJa =
    purpose === 'registration' ? 'メールアドレスを認証してください' : '新しいメールアドレスを確認してください';
  const text = `Please ${action} by opening this link. The link expires in 24 hours and can only be used once.\n${actionJa}。リンクは24時間有効で、1回のみ使用できます。\n\n${url}\n\nIf you did not request this, you can ignore this email.\nこの操作に心当たりがない場合は、このメールを無視してください。`;
  const html = `<p>Please ${action} by clicking the link below. The link expires in 24 hours and can only be used once.</p><p>${actionJa}。リンクは24時間有効で、1回のみ使用できます。</p><p><a href="${url}">Continue to Flaxia</a></p><p>If you did not request this, you can ignore this email.<br>この操作に心当たりがない場合は、このメールを無視してください。</p>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || 'Flaxia <no-reply@flaxia.app>',
        to: [email],
        subject,
        text,
        html,
      }),
    });
    return response.ok;
  } catch {
    // Do not log provider errors: they may contain request details or secrets.
    return false;
  }
}

export async function issueEmailVerification(env: Bindings, request: VerificationRequest): Promise<boolean> {
  if (!isEmailDeliveryConfigured(env)) return false;

  const email = normalizeEmail(request.email);
  const token = createToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const url = getVerificationUrl(env, token);

  // A failed delivery must not invalidate an existing working link. The
  // provider can accept a message before DB persistence fails; in that case
  // the new link is unusable, but the previous link remains valid.
  if (!(await sendVerificationEmail(env, email, request.purpose, url))) return false;

  // D1 batch commits the replacement atomically after successful delivery.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM email_verification_tokens WHERE user_id = ? AND purpose = ?').bind(
      request.userId,
      request.purpose,
    ),
    env.DB.prepare(
      'INSERT INTO email_verification_tokens (token_hash, purpose, user_id, candidate_email, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(tokenHash, request.purpose, request.userId, email, expiresAt),
  ]);

  return true;
}

export async function consumeEmailVerificationToken(
  env: Bindings,
  token: string,
): Promise<EmailVerificationPurpose | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = await hashToken(token);
  const record = await env.DB.prepare(
    "SELECT purpose, user_id, candidate_email FROM email_verification_tokens WHERE token_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  )
    .bind(tokenHash)
    .first<VerificationTokenRow>();
  if (!record) return null;

  // Both statements run in one D1 transaction. The UPDATE only succeeds if
  // this token still exists and is unexpired, so competing consumers cannot
  // update the same user after the winning request deletes the token. If the
  // UPDATE does not apply, the conditional DELETE leaves the link intact.
  const verifiedAt = new Date().toISOString();
  const tokenStillValid =
    "EXISTS (SELECT 1 FROM email_verification_tokens WHERE token_hash = ? AND user_id = users.id AND purpose = ? AND candidate_email = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
  const update =
    record.purpose === 'registration'
      ? env.DB.prepare(
          `UPDATE users SET email_verified_at = ?
           WHERE id = ? AND email = ? AND email_verified_at IS NULL AND ${tokenStillValid}`,
        ).bind(verifiedAt, record.user_id, record.candidate_email, tokenHash, record.purpose, record.candidate_email)
      : env.DB.prepare(
          `UPDATE users SET email = ?, email_verified_at = ?
           WHERE id = ? AND email_verified_at IS NOT NULL AND ${tokenStillValid}
             AND NOT EXISTS (
               SELECT 1 FROM users other
               WHERE lower(other.email) = lower(?) AND other.id != users.id
             )`,
        ).bind(
          record.candidate_email,
          verifiedAt,
          record.user_id,
          tokenHash,
          record.purpose,
          record.candidate_email,
          record.candidate_email,
        );
  const [updated] = await env.DB.batch([
    update,
    env.DB.prepare(
      `DELETE FROM email_verification_tokens WHERE user_id = ?
       AND EXISTS (SELECT 1 FROM users WHERE users.id = ? AND users.email_verified_at = ? AND users.email = ?)`,
    ).bind(record.user_id, record.user_id, verifiedAt, record.candidate_email),
  ]);
  if (!updated.success || (updated.meta?.changes ?? 0) !== 1) return null;
  return record.purpose;
}
