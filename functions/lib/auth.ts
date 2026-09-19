import { nanoid } from 'nanoid';
import { serverStep1, serverStep2 } from './srp';

export interface User {
  id: string;
  email: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_key?: string;
  language?: string;
  ng_words?: string;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: string;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16)) as Uint8Array<ArrayBuffer>;

  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = (await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  )) as ArrayBuffer;

  const combined = new Uint8Array(salt.byteLength + hash.byteLength);
  combined.set(salt, 0);
  combined.set(new Uint8Array(hash), salt.byteLength);
  return uint8ArrayToBase64(combined);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const combined = base64ToUint8Array(stored);
  const salt = combined.slice(0, 16);
  const originalHash = combined.slice(16);

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = (await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  )) as ArrayBuffer;

  const hashBytes = new Uint8Array(hash as ArrayBuffer);
  // Constant-time comparison to avoid leaking the hash via timing. The length
  // is fixed by the algorithm (SHA-256 → 32 bytes), so an early length check
  // does not leak secret-dependent information.
  if (hashBytes.length !== originalHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hashBytes.length; i++) {
    diff |= hashBytes[i] ^ originalHash[i];
  }
  return diff === 0;
}

// Generate session token
function generateSessionToken(): string {
  return nanoid(32);
}

// Create session
export async function createSession(env: Env, userId: string): Promise<Session> {
  const sessionId = generateSessionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  const result = await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `)
    .bind(sessionId, userId, expiresAt)
    .run();

  if (!result.success) {
    throw new Error('Failed to create session');
  }

  return {
    id: sessionId,
    user_id: userId,
    expires_at: expiresAt,
  };
}

// Get session by token
export async function getSession(env: Env, token: string): Promise<{ user: User; session: Session } | null> {
  if (!token) return null;

  // Get session from database
  const session = (await env.DB.prepare(`
    SELECT * FROM sessions WHERE id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)
    .bind(token)
    .first()) as Session | undefined;

  if (!session) return null;

  // Get user from database
  const user = (await env.DB.prepare(`
    SELECT id, email, username, display_name, bio, avatar_key, created_at
    FROM users WHERE id = ?
  `)
    .bind(session.user_id)
    .first()) as User | undefined;

  if (!user) return null;

  return { user, session };
}

// Get user with session using single JOIN query for /api/me optimization
export async function getMeWithSession(env: Env, token: string, cache?: KVNamespace): Promise<{ user: User } | null> {
  if (!token) return null;

  // Hash the token for safe use as KV key (avoid leaking token in logs)
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const cacheKey = `session:${hashHex}`;
  if (cache) {
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as { user: User };
      }
    } catch {
      // Ignore cache errors, fall through to D1
    }
  }

  // Get user and session with single JOIN query
  const result = (await env.DB.prepare(`
    SELECT 
      u.id, u.email, u.username, u.display_name, 
      u.bio, u.avatar_key, u.language, u.ng_words, u.created_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
      AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)
    .bind(token)
    .first()) as User | undefined;

  if (!result) return null;

  // Cache the result in KV (30s TTL)
  if (cache) {
    try {
      await cache.put(cacheKey, JSON.stringify({ user: result }), { expirationTtl: 30 });
    } catch {
      // Ignore cache write errors
    }
  }

  return { user: result };
}

// Extend session (sliding window)
export async function extendSession(env: Env, token: string): Promise<boolean> {
  if (!token) return false;

  // Update session expiration to 7 days from now
  const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = await env.DB.prepare(`
    UPDATE sessions 
    SET expires_at = ? 
    WHERE id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)
    .bind(newExpiresAt, token)
    .run();

  return (
    (result as { success: boolean; changes?: number }).success &&
    ((result as { success: boolean; changes?: number }).changes ?? 0) > 0
  );
}

// Delete session
export async function deleteSession(env: Env, token: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
  return result.success;
}

export interface SrpRegistration {
  salt: string; // base64 (16 bytes)
  verifier: string; // base64 (256 bytes)
  group: string; // '2048'
}

// Register user. Supports either legacy password-based registration or
// SRP-based registration where the client computes the verifier locally.
export async function registerUser(
  env: Env,
  userData: {
    email: string;
    password?: string;
    username: string;
    display_name: string;
    srp?: SrpRegistration;
  },
): Promise<User> {
  const { email, password, username, display_name, srp } = userData;

  // Check if email already exists
  const existingEmail = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existingEmail) {
    throw new Error('Email already registered');
  }

  // Check if username already exists (case-insensitive)
  const existingUsername = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first();
  if (existingUsername) {
    throw new Error('Username already taken');
  }

  // Generate user ID
  const userId = nanoid();

  let passwordHash: string = '';
  let srpSalt: string | null = null;
  let srpVerifier: string | null = null;
  let srpGroup: string | null = null;

  if (srp) {
    if (srp.group !== '2048') throw new Error('Unsupported SRP group');
    // Basic length sanity checks (16-byte salt, 256-byte verifier).
    if (base64ToUint8Array(srp.salt).length !== 16) throw new Error('Invalid SRP salt');
    if (base64ToUint8Array(srp.verifier).length !== 256) throw new Error('Invalid SRP verifier');
    srpSalt = srp.salt;
    srpVerifier = srp.verifier;
    srpGroup = srp.group;
    // SRP-only accounts have no legacy hash; store empty string so the NOT
    // NULL column is satisfied and legacy login correctly fails.
    passwordHash = '';
  } else if (password) {
    passwordHash = await hashPassword(password);
  } else {
    throw new Error('Password or SRP verifier required');
  }

  // Create user
  const result = await env.DB.prepare(`
    INSERT INTO users (id, email, password_hash, username, display_name, bio, srp_salt, srp_verifier, srp_group)
    VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)
  `)
    .bind(userId, email, passwordHash, username, display_name, srpSalt, srpVerifier, srpGroup)
    .run();

  if (!result.success) {
    throw new Error('Failed to create user');
  }

  // Return user without password hash
  const user = (await env.DB.prepare(`
    SELECT id, email, username, display_name, bio, avatar_key, created_at
    FROM users WHERE id = ?
  `)
    .bind(userId)
    .first()) as User;

  return user;
}

// Begin an SRP login: returns the server ephemeral B and the user's salt.
// Returns null if the user has no SRP verifier (client should fall back to legacy).
export async function startSrpLogin(
  env: Env,
  email: string,
): Promise<{ challengeId: string; salt: string; B: string } | null> {
  const user = (await env.DB.prepare('SELECT id, srp_salt, srp_verifier FROM users WHERE email = ?')
    .bind(email)
    .first()) as { id: string; srp_salt: string | null; srp_verifier: string | null } | null;

  if (!user || !user.srp_verifier || !user.srp_salt) return null;

  const salt = base64ToUint8Array(user.srp_salt);
  const v = base64ToUint8Array(user.srp_verifier);
  const { B, b } = await serverStep1(salt, v);
  const challengeId = nanoid(32);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const insert = await env.DB.prepare(
    'INSERT INTO srp_handshakes (id, user_id, b_scalar, b_pub, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(challengeId, user.id, b.toString(), uint8ArrayToBase64(B), expiresAt)
    .run();
  if (!insert.success) throw new Error('Failed to store SRP handshake');

  return { challengeId, salt: user.srp_salt, B: uint8ArrayToBase64(B) };
}

// Finish an SRP login: validates M1 and returns the session on success.
export async function verifySrpLogin(
  env: Env,
  email: string,
  challengeId: string,
  A: string,
  M1: string,
): Promise<{ user: User; session: Session; M2: string } | null> {
  const hs = (await env.DB.prepare(
    "SELECT * FROM srp_handshakes WHERE id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  )
    .bind(challengeId)
    .first()) as { user_id: string; b_scalar: string; b_pub: string } | null;
  if (!hs) return null;

  const user = (await env.DB.prepare(`
    SELECT id, email, srp_salt, srp_verifier, username, display_name, bio, avatar_key, created_at
    FROM users WHERE id = ?
  `)
    .bind(hs.user_id)
    .first()) as {
    id: string;
    email: string;
    srp_salt: string | null;
    srp_verifier: string | null;
    username: string;
    display_name: string;
    bio: string;
    avatar_key: string | null;
    created_at: string;
  } | null;
  if (!user || !user.srp_verifier || !user.srp_salt) return null;

  const v = base64ToUint8Array(user.srp_verifier);
  const B = base64ToUint8Array(hs.b_pub);
  const A_bytes = base64ToUint8Array(A);
  const M1_bytes = base64ToUint8Array(M1);

  const result = await serverStep2(A_bytes, B, BigInt(hs.b_scalar), v, M1_bytes);
  if (!result) return null;

  await env.DB.prepare('DELETE FROM srp_handshakes WHERE id = ?').bind(challengeId).run();

  const session = await createSession(env, user.id);
  const safeUser: User = {
    id: user.id,
    email: user.email,
    username: user.username,
    display_name: user.display_name,
    bio: user.bio,
    avatar_key: user.avatar_key ?? undefined,
    created_at: user.created_at,
  };
  return { user: safeUser, session, M2: uint8ArrayToBase64(result.M2) };
}

// Store (or replace) the SRP verifier for an already-authenticated user.
// Used to upgrade a legacy account to SRP.
export async function upgradeSrp(env: Env, userId: string, srp: SrpRegistration): Promise<void> {
  if (srp.group !== '2048') throw new Error('Unsupported SRP group');
  if (base64ToUint8Array(srp.salt).length !== 16) throw new Error('Invalid SRP salt');
  if (base64ToUint8Array(srp.verifier).length !== 256) throw new Error('Invalid SRP verifier');
  const result = await env.DB.prepare('UPDATE users SET srp_salt = ?, srp_verifier = ?, srp_group = ? WHERE id = ?')
    .bind(srp.salt, srp.verifier, srp.group, userId)
    .run();
  if (!result.success) throw new Error('Failed to upgrade SRP');
}

// Verify an SRP proof of the CURRENT password without creating a session. Used by
// the password-change flow so SRP-only accounts (no legacy password hash) still
// have to prove knowledge of the current password before it can be changed.
export async function verifySrpPassword(
  env: Env,
  userId: string,
  challengeId: string,
  A: string,
  M1: string,
): Promise<boolean> {
  const hs = (await env.DB.prepare(
    "SELECT * FROM srp_handshakes WHERE id = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  )
    .bind(challengeId)
    .first()) as { user_id: string; b_scalar: string; b_pub: string } | null;
  if (!hs || hs.user_id !== userId) return false;

  const user = (await env.DB.prepare('SELECT srp_salt, srp_verifier FROM users WHERE id = ?').bind(userId).first()) as {
    srp_salt: string | null;
    srp_verifier: string | null;
  } | null;
  if (!user || !user.srp_verifier || !user.srp_salt) return false;

  const v = base64ToUint8Array(user.srp_verifier);
  const B = base64ToUint8Array(hs.b_pub);
  const A_bytes = base64ToUint8Array(A);
  const M1_bytes = base64ToUint8Array(M1);

  const result = await serverStep2(A_bytes, B, BigInt(hs.b_scalar), v, M1_bytes);
  await env.DB.prepare('DELETE FROM srp_handshakes WHERE id = ?').bind(challengeId).run();
  return !!result;
}

// Login user
export async function loginUser(env: Env, email: string, password: string): Promise<{ user: User; session: Session }> {
  // Get user with password hash
  const userWithPassword = (await env.DB.prepare(`
    SELECT id, email, password_hash, username, display_name, bio, avatar_key, created_at
    FROM users WHERE email = ?
  `)
    .bind(email)
    .first()) as {
    id: string;
    email: string;
    password_hash: string;
    username: string;
    display_name: string;
    bio: string;
    avatar_key: string | null;
    created_at: string;
  } | null;

  if (!userWithPassword) {
    throw new Error('Invalid credentials');
  }

  // Verify password
  const isValid = await verifyPassword(password, userWithPassword.password_hash);
  if (!isValid) {
    throw new Error('Invalid credentials');
  }

  // Create session
  const session = await createSession(env, userWithPassword.id);

  // Return user without password hash
  const user: User = {
    id: userWithPassword.id,
    email: userWithPassword.email,
    username: userWithPassword.username,
    display_name: userWithPassword.display_name,
    bio: userWithPassword.bio,
    avatar_key: userWithPassword.avatar_key ?? undefined,
    created_at: userWithPassword.created_at,
  };

  return { user, session };
}

// Extract session token from request
export function getSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map((cookie) => cookie.trim());
  const sessionCookie = cookies.find((cookie) => cookie.startsWith('session='));

  return sessionCookie ? sessionCookie.substring('session='.length) : null;
}

// Set session cookie
export function setSessionCookie(response: Response, token: string, isSecure = true): void {
  response.headers.set(
    'Set-Cookie',
    `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 60 * 60}`,
  );
}

// Clear session cookie
export function clearSessionCookie(response: Response, isSecure = true): void {
  response.headers.set('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
}
