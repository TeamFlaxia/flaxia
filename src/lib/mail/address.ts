// Mail address helpers (docs/mail.md §7, §11.2).
//
// Primary address is `username@flaxia.app` (lowercase). Reserved locals are
// blocked at activation and never provisionable as primary addresses.

export const MAIL_DOMAIN = 'flaxia.app';
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,20}$/;

// Operational locals must never become user mailboxes, and lookalikes such as
// root@/hostmaster@ invite impersonation. This is the single source of truth
// for the SPA, Pages proxy, and Mail Worker.
export const RESERVED_LOCALS = new Set([
  'admin',
  'administrator',
  'abuse',
  'api',
  'app',
  'auth',
  'billing',
  'bounce',
  'bounces',
  'contact',
  'dkim',
  'dmarc',
  'dns',
  'donotreply',
  'flaxia',
  'help',
  'hostmaster',
  'info',
  'legal',
  'mail',
  'mailerdaemon',
  'marketing',
  'news',
  'no_reply',
  'noreply',
  'postmaster',
  'press',
  'privacy',
  'registrar',
  'root',
  'sales',
  'security',
  'spam',
  'spf',
  'status',
  'support',
  'team',
  'webmaster',
  'www',
]);

export function normalizeMailAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function primaryAddressForUsername(username: string, domain = MAIL_DOMAIN): string {
  const local = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(local)) throw new Error('mail_invalid_username');
  if (RESERVED_LOCALS.has(local)) throw new Error('mail_reserved');
  return `${local}@${domain}`;
}

export function isReservedLocal(local: string): boolean {
  return RESERVED_LOCALS.has(local.trim().toLowerCase());
}

export function isValidMailAddress(address: string): boolean {
  const normalized = normalizeMailAddress(address);
  const at = normalized.lastIndexOf('@');
  if (at < 1) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(local)) return false;
  return domain === MAIL_DOMAIN || domain.endsWith(`.${MAIL_DOMAIN}`);
}
