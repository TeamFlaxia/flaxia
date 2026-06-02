export function isAdmin(env: any, username: string): boolean {
  if (!env.ADMIN_USERNAMES) {
    return false;
  }
  return env.ADMIN_USERNAMES.split(',')
    .map((u: string) => u.trim())
    .includes(username);
}
