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

export async function loadSessionUser(): Promise<SessionUser | null> {
  const { getMe } = await import('../auth-cache.ts');
  const me = await getMe();
  current = (me?.user as SessionUser | undefined) ?? null;
  return current;
}
