/**
 * Only same-origin absolute paths may be used as a post-login destination.
 * Anything that could become an open redirect (absolute URLs, protocol-relative
 * paths, backslash tricks, control characters) falls back to /home.
 */
export function safeReturnPath(raw: string | null): string {
  if (!raw || raw.length > 512) return '/home';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/home';
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return '/home';
  }
  return raw;
}

/**
 * Flaxia stores a reserved `@users.flaxia.invalid` placeholder for accounts
 * without a real email. Only a real address may be copied to Auth, where it
 * becomes an additional login identifier.
 */
export function realProfileEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const value = email.trim().toLowerCase();
  if (value.length === 0 || value.length > 254 || value.endsWith('.invalid')) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}
