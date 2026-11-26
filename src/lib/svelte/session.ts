export interface SessionUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
}

/**
 * SSR may inline the session snapshot into the page. Seeding the synchronous
 * snapshot at module evaluation lets onMount adopt the real user (or an
 * explicit guest) without an /api/me request. A missing key means "unknown",
 * so the native/degraded path still loads the session as before.
 */
const hasBootSession = typeof window !== 'undefined' && '__FLAXIA_SESSION__' in window;
const bootSession = hasBootSession
  ? (window as unknown as { __FLAXIA_SESSION__: SessionUser | null }).__FLAXIA_SESSION__
  : null;
let current: SessionUser | null = hasBootSession ? (bootSession ?? null) : null;

/** Synchronous session snapshot, seeded from SSR boot data or by the root layout. */
export function getSessionUser(): SessionUser | null {
  return current;
}

/** Drop the snapshot on logout/deletion so the header cannot stay signed in. */
export function clearSessionUser(): void {
  current = null;
}

export async function loadSessionUser(): Promise<SessionUser | null> {
  if (hasBootSession) return current;
  const { getMe } = await import('../auth-cache.ts');
  const me = await getMe();
  current = (me?.user as SessionUser | undefined) ?? null;
  // Viewer-scoped caches (SSR data) must be dropped when the identity changes.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('flaxia:session'));
  return current;
}
