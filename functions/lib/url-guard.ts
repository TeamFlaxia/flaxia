// SSRF guard for server-side fetches of user-controlled URLs.
//
// The Workers platform blocks requests that are clearly aimed at the local
// machine, but application code must not rely on that alone: a fetch that is
// allowed to *follow* a redirect can leave the validated URL behind, and a
// hostname that merely *looks* public can resolve to a private address. This
// module therefore:
//
//   1. validates the scheme, hostname and (already URL-normalized) IP literal
//      of a URL, including IPv4-mapped IPv6 forms such as `[::ffff:127.0.0.1]`
//      which the previous ad-hoc check let through, and
//   2. performs redirects manually so every hop is validated again before the
//      next request is sent.
//
// DNS answers cannot be inspected from Workers, so a name that resolves to a
// private address at connection time (DNS rebinding) remains a residual risk;
// combined with platform egress filtering and the checks below this is the
// strongest guarantee available in this runtime.

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'local',
  'broadcasthost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'kubernetes.default.svc',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

function isBlockedHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  // IP literals are classified by isPrivateHost, not DNS-name rules.
  if (isIpv4(name) || name.includes(':')) return false;
  if (BLOCKED_HOSTNAMES.has(name)) return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  // A public DNS name always has a dot; a bare label can only resolve through
  // a search suffix / hosts file, i.e. something local.
  if (!name.includes('.')) return true;
  return false;
}

interface Ipv4Parts {
  a: number;
  b: number;
  c: number;
  d: number;
}

function isIpv4(hostname: string): Ipv4Parts | null {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const parts = [match[1], match[2], match[3], match[4]].map(Number);
  if (parts.some((part) => part > 255)) return null;
  return { a: parts[0], b: parts[1], c: parts[2], d: parts[3] };
}

function isPrivateIpv4({ a, b, c }: Ipv4Parts): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Expand an IPv6 literal (without brackets) into eight 16-bit groups, or null when malformed. */
function expandIpv6(hostname: string): number[] | null {
  let address = hostname;
  // An embedded dotted-quad is easier to handle after conversion to hex groups.
  const v4Tail = address.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail) {
    const v4 = isIpv4(v4Tail[1]);
    if (!v4) return null;
    const high = ((v4.a << 8) | v4.b).toString(16);
    const low = ((v4.c << 8) | v4.d).toString(16);
    address = `${address.slice(0, v4Tail.index)}${high}:${low}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isPrivateIpv6(groups: number[]): boolean {
  const isZeroPrefix = groups.slice(0, 8).every((group) => group === 0);
  if (isZeroPrefix) return true; // ::
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 1
  ) {
    return true; // ::1 loopback
  }

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x2001 && groups[1] === 0x0000) return true; // 2001::/32 Teredo

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms.
  const embeddedIpv4 = (block: number[]): boolean =>
    block[0] <= 255 && block[1] <= 255 && block[2] <= 255 && block[3] <= 255
      ? isPrivateIpv4({ a: block[0], b: block[1], c: block[2], d: block[3] })
      : true;

  const ipv4FromGroups = (high: number, low: number): number[] => [high >> 8, high & 0xff, low >> 8, low & 0xff];

  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return embeddedIpv4(ipv4FromGroups(groups[6], groups[7]));
  }
  if (first === 0x2002) {
    // 6to4 embeds the IPv4 address in groups 1-2.
    return embeddedIpv4(ipv4FromGroups(groups[1], groups[2]));
  }
  if (first === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0) {
    return embeddedIpv4(ipv4FromGroups(groups[6], groups[7]));
  }
  return false;
}

/** True when the host is (or embeds) a loopback, private, link-local or otherwise non-public address. */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.toLowerCase();

  const v4 = isIpv4(host);
  if (v4) return isPrivateIpv4(v4);

  if (host.includes(':')) {
    const groups = expandIpv6(host);
    if (!groups) return true; // unparseable literal: fail closed
    return isPrivateIpv6(groups);
  }

  return false;
}

/** Returns null when the URL may be fetched, or a human-readable reason when it may not. */
export function checkUrlForSsrf(url: URL): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http and https URLs are allowed';
  }
  if (isBlockedHostname(url.hostname)) {
    return `Requests to ${url.hostname} are not allowed`;
  }
  if (isPrivateHost(url.hostname)) {
    return 'Requests to private IP addresses are not allowed';
  }
  return null;
}

/** Parse and validate a user-supplied URL string. Throws SsrfError when unsafe. */
export function parsePublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  const reason = checkUrlForSsrf(url);
  if (reason) throw new SsrfError(reason);
  return url;
}

export interface GuardedFetchOptions extends RequestInit {
  /** Maximum number of redirect hops to follow (default 5). */
  maxRedirects?: number;
  timeoutMs?: number;
}

/**
 * fetch() for URLs derived from user input. Redirects are followed manually and
 * each hop is re-validated, so a public URL cannot bounce the request to
 * localhost, a private address, or a non-HTTP scheme.
 */
export async function fetchWithSsrfGuard(rawUrl: string, options: GuardedFetchOptions = {}): Promise<Response> {
  const { maxRedirects = DEFAULT_MAX_REDIRECTS, timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;
  let current = parsePublicHttpUrl(rawUrl);
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(current.toString(), {
      ...init,
      redirect: 'manual',
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('Location');
    if (!location) return response;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new SsrfError('Invalid redirect URL');
    }
    const reason = checkUrlForSsrf(next);
    if (reason) throw new SsrfError(`Redirect blocked: ${reason}`);
    current = next;
  }

  throw new SsrfError('Too many redirects');
}
