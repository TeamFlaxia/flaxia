/**
 * Shared SSRF-guard helpers used by the main Pages API and the ActivityPub
 * queue worker. Kept origin-agnostic (no `net` module available on Workers)
 * so every outbound fetch can validate hostnames/IPs before use.
 */

function isPrivateIPv4(octets: number[]): boolean {
  if (octets.length !== 4) return true;
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = octets;
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16
  if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 198.18.0.0/15
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function isPrivateIPv6(normalized: string): boolean {
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // IPv4-mapped / IPv4-compatible: ::ffff:127.0.0.1, ::127.0.0.1
  const mapped = normalized.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped.slice(1).map(Number));
  const compat = normalized.match(/^0:0:0:0:0:0:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (compat) return isPrivateIPv4(compat.slice(1).map(Number));
  return false;
}

export function isPrivateIP(hostname: string): boolean {
  let host = hostname;
  // Strip IPv6 brackets
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const lower = host.toLowerCase();

  if (lower.includes(':')) {
    return isPrivateIPv6(lower);
  }

  // IPv4. WHATWG URL normalizes most encodings, but be defensive about
  // trailing dots and integer/hex literals anyway.
  const clean = lower.replace(/\.$/, '');

  // Single-integer (decimal) form: 2130706433 -> 127.0.0.1
  if (/^\d+$/.test(clean)) {
    const num = Number(clean);
    if (!Number.isSafeInteger(num) || num > 0xffffffff) return true;
    return isPrivateIPv4([(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255]);
  }
  // Hex form: 0x7f000001 / 0X7F000001 -> 127.0.0.1
  if (/^0[xX][\da-fA-F]+$/.test(clean)) {
    const num = parseInt(clean, 16);
    if (num > 0xffffffff) return true;
    return isPrivateIPv4([(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255]);
  }
  // Octet shorthand: 127.1 -> 127.0.0.1
  const short = clean.match(/^(\d{1,3})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?$/);
  if (short) {
    const parts = short
      .slice(1)
      .filter((p): p is string => typeof p === 'string')
      .map(Number);
    const octets = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
    return isPrivateIPv4(octets);
  }
  return false;
}

export function isInternalHostname(hostname: string): string | null {
  const lower = hostname.toLowerCase();
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  const internalNames = new Set([
    'localhost',
    'localhost.localdomain',
    'local',
    'broadcasthost',
    'metadata.google.internal',
    'metadata',
    '169.254.169.254',
  ]);
  if (internalNames.has(name)) return name;
  if (name.endsWith('.internal') || name.endsWith('.local') || name.endsWith('.localhost')) return name;
  return null;
}

export function checkSSRF(url: URL): string | null {
  const hostname = url.hostname;
  const cleanHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isPrivateIP(cleanHost)) return 'Requests to private IP addresses are not allowed';
  const internal = isInternalHostname(hostname);
  if (internal) return `Requests to ${internal} are not allowed`;
  return null;
}

/**
 * Fetch a URL while validating each redirect hop. Returns null when the URL,
 * any redirect target, or an intermediate hop is disallowed.
 */
export async function safeFetch(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response | null> {
  let current = url;
  let redirects = 0;
  const requestInit: RequestInit = { ...init, redirect: 'manual' };

  while (true) {
    let target: URL;
    try {
      target = new URL(current);
    } catch {
      return null;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    const blocked = checkSSRF(target);
    if (blocked) return null;

    const response = await fetch(current, requestInit);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    if (!location || redirects >= maxRedirects) return null;
    try {
      current = new URL(location, current).toString();
    } catch {
      return null;
    }
    redirects += 1;
  }
}
