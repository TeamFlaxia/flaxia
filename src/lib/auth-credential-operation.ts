const KEY = 'flaxia.pending-credential-change.v1';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
type Pending = { userId: string; operation: string };
function readPending(): Pending | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Pending> | null;
    return value &&
      typeof value.userId === 'string' &&
      typeof value.operation === 'string' &&
      TOKEN.test(value.operation)
      ? { userId: value.userId, operation: value.operation }
      : null;
  } catch {
    return null;
  }
}
export function credentialOperationFor(userId: string): string {
  const existing = readPending();
  if (existing?.userId === userId) return existing.operation;
  if (existing) throw new Error('Another account credential change is pending');
  const operation = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  localStorage.setItem(KEY, JSON.stringify({ userId, operation }));
  return operation;
}
export function clearCredentialOperation(): void {
  localStorage.removeItem(KEY);
}
export async function retryPendingCredentialChange(): Promise<
  'none' | 'committed' | 'cancelled' | 'pending' | 'not_found'
> {
  const pending = readPending();
  if (!pending) return 'none';
  try {
    const response = await fetch('/api/users/me/credentials/retry', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: pending.operation }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      clearCredentialOperation();
      return 'committed';
    }
    if (response.status === 404) return 'not_found';
    const result = (await response.json().catch(() => null)) as { cancelled?: unknown } | null;
    if (result?.cancelled === true) {
      clearCredentialOperation();
      return 'cancelled';
    }
    return 'pending';
  } catch {
    return 'pending';
  }
}
