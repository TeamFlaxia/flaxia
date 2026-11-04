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
