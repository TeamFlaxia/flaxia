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

export async function seedUserAndLogin(suffix = '1') {
  await registerUser({
    email: `user${suffix}@test.com`,
    password: 'password123',
    username: `testuser${suffix}`,
    display_name: `Test User ${suffix}`,
  });
  return loginUser(`user${suffix}@test.com`, 'password123');
}
