export const BASE_URL = 'http://localhost:8788';

export async function resetDb(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/reset`, { method: 'POST' });
  if (!res.ok) throw new Error('DB reset failed');
}

export async function registerUser(data: {
  email: string;
  password: string;
  username: string;
  display_name: string;
}): Promise<Response> {
  return fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function loginUser(email: string, password: string): Promise<{ res: Response; cookie: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  return { res, cookie };
}

// Learnable usernames must be 1-20 chars of [a-zA-Z0-9_]; test suffixes may
// contain punctuation or be long, so sanitize and append a stable hash when
// truncation alone would collide.
function testUsername(suffix: string): string {
  const sanitized = `testuser${suffix}`.replace(/[^a-zA-Z0-9_]/g, '');
  if (sanitized.length <= 20) return sanitized;
  let hash = 5381;
  for (let i = 0; i < suffix.length; i++) hash = ((hash << 5) + hash + suffix.charCodeAt(i)) >>> 0;
  return `${sanitized.slice(0, 12)}${hash.toString(36).slice(0, 7)}`;
}

export async function seedUserAndLogin(suffix = '1') {
  const username = testUsername(suffix);
  await registerUser({
    email: `user${suffix}@test.com`,
    password: 'password123',
    username,
    display_name: `Test User ${suffix}`,
  });
  const login = await loginUser(`user${suffix}@test.com`, 'password123');
  return {
    ...login,
    username,
    email: `user${suffix}@test.com`,
    display_name: `Test User ${suffix}`,
    password: 'password123',
  };
}
