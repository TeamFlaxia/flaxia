import { nanoid } from 'nanoid';

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
  ip_address?: string;
  user_agent?: string;
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
  return hashBytes.every((b, i) => b === originalHash[i]);
}

// Generate session token
function generateSessionToken(): string {
  return nanoid(32);
}

// Create session
export async function createSession(
  env: Env,
  userId: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<Session> {
  const sessionId = generateSessionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  const result = await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `)
    .bind(sessionId, userId, expiresAt, ipAddress || '', userAgent || '')
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
export async function getSession(
  env: Env,
  token: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<{ user: User; session: Session } | null> {
  if (!token) return null;

  // Get session from database
  const session = (await env.DB.prepare(`
    SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')
  `)
    .bind(token)
    .first()) as Session | undefined;

  if (!session) return null;

  // Verify IP and User-Agent if bound
  if (session.ip_address) {
    const storedIp = session.ip_address;
    const clientIp = ipAddress || '';
    if (storedIp !== clientIp) {
      return null;
    }
  }
  if (session.user_agent) {
    const storedUa = session.user_agent;
    const clientUa = userAgent || '';
    if (storedUa !== clientUa) {
      return null;
    }
  }

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
export async function getMeWithSession(env: Env, token: string): Promise<{ user: User } | null> {
  if (!token) return null;

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

  return result ? { user: result } : null;
}

// Extend session (sliding window)
export async function extendSession(env: Env, token: string): Promise<boolean> {
  if (!token) return false;

  // Update session expiration to 7 days from now
  const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = await env.DB.prepare(`
    UPDATE sessions 
    SET expires_at = ? 
    WHERE id = ? AND expires_at > datetime('now')
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

// Register user
export async function registerUser(
  env: Env,
  userData: {
    email: string;
    password: string;
    username: string;
    display_name: string;
  },
): Promise<User> {
  const { email, password, username, display_name } = userData;

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

  // Hash password
  const passwordHash = await hashPassword(password);

  // Create user
  const result = await env.DB.prepare(`
    INSERT INTO users (id, email, password_hash, username, display_name, bio)
    VALUES (?, ?, ?, ?, ?, '')
  `)
    .bind(userId, email, passwordHash, username, display_name)
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

// Login user
export async function loginUser(
  env: Env,
  email: string,
  password: string,
  ipAddress?: string,
  userAgent?: string,
): Promise<{ user: User; session: Session }> {
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
  const session = await createSession(env, userWithPassword.id, ipAddress, userAgent);

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
