export interface SessionUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
}

let current: SessionUser | null = null;

/** Synchronous session snapshot, populated by the root layout before routes mount. */
export function getSessionUser(): SessionUser | null {
  return current;
}

/** Drop the snapshot on logout/deletion so the header cannot stay signed in. */
export function clearSessionUser(): void {
  current = null;
}

export async function loadSessionUser(): Promise<SessionUser | null> {
  const { getMe } = await import('../auth-cache.ts');
  const me = await getMe();
  current = (me?.user as SessionUser | undefined) ?? null;
  return current;
}
