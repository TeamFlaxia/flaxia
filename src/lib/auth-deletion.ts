const KEY = 'flaxia.pending-account-deletion.v1';
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

export function deletionOperationFor(userId: string): string {
  const existing = readPending();
  if (existing?.userId === userId) return existing.operation;
  if (existing) throw new Error('Another account deletion is pending');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const operation = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  // Do not begin a remote deletion unless its retry capability is durable.
  localStorage.setItem(KEY, JSON.stringify({ userId, operation }));
  return operation;
}

export function clearDeletionOperation(): void {
  localStorage.removeItem(KEY);
}

export async function retryPendingDeletion(): Promise<boolean> {
  const pending = readPending();
  if (!pending) return false;
  try {
    const response = await fetch('/api/users/me/deletion/retry', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: pending.operation }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) {
      // No job exists for this capability anymore; do not let it block a
      // different account using the same browser.
      clearDeletionOperation();
      return false;
    }
    if (!response.ok) return false;
    clearDeletionOperation();
    return true;
  } catch {
    return false;
  }
}
