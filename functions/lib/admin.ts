export interface AdminUser {
  id: string;
  username: string;
  role?: string | null;
}

// #134: admin rights live on the user row, not on a username allowlist.
// A username can be deleted and re-registered by anyone; a role cannot be
// taken over that way. ADMIN_USERNAMES remains only as a bootstrap fallback
// until every deployment has its admin role assigned (then leave it empty).
export function isAdmin(env: { ADMIN_USERNAMES?: string }, user: AdminUser | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!env.ADMIN_USERNAMES || !user.username) return false;
  return env.ADMIN_USERNAMES.split(',')
    .map((u: string) => u.trim())
    .includes(user.username);
}
