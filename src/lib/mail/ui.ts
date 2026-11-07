import { getLocale, t } from '../i18n.js';
import { type IconName, icon } from '../icons.js';
import type { MailSecurity } from './api.js';

export function mailInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const first = Array.from(trimmed)[0] ?? '?';
  return first.toUpperCase();
}

export function formatMailDate(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const locale = getLocale();
  const sameDay = date.toDateString() === new Date(now).toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return t('mail.yesterday') || 'Yesterday';
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

export function securityLabel(security: MailSecurity): string {
  if (security === 'e2ee') return t('mail.security_e2ee') || 'End-to-end encrypted';
  if (security === 'tls') return t('mail.security_tls') || 'TLS only';
  return t('mail.security_at_rest') || 'Encrypted at rest';
}

export function securityChip(security: MailSecurity): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `mail-chip mail-chip--${security.replace('_', '-')}`;
  const iconName: IconName = security === 'e2ee' ? 'shield' : security === 'at_rest' ? 'lock' : 'mail-open';
  chip.appendChild(icon(iconName, { width: '11', height: '11' }));
  const label = document.createElement('span');
  label.textContent = securityLabel(security);
  chip.appendChild(label);
  return chip;
}

/**
 * Re-trigger the state pop (`.is-popping`) used for toggles such as star.
 * Mirrors motion.css `icon-lift` / `bookmark-hop`: the pop runs once and is
 * removed so the next toggle plays it again.
 */
export function triggerPop(el: HTMLElement): void {
  el.classList.remove('is-popping');
  // Restart the CSS animation on the next frame.
  void el.offsetWidth;
  el.classList.add('is-popping');
  window.setTimeout(() => el.classList.remove('is-popping'), 300);
}

export function iconButton(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mail-icon-button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(icon(name, { width: '18', height: '18' }));
  button.addEventListener('click', onClick);
  return button;
}

export function mailButton(
  label: string,
  variant: 'primary' | 'secondary' | 'ghost' = 'secondary',
  iconName?: IconName,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `mail-button mail-button--${variant}`;
  if (iconName) button.appendChild(icon(iconName, { width: '15', height: '15' }));
  const text = document.createElement('span');
  text.textContent = label;
  button.appendChild(text);
  return button;
}

export function emptyState(iconName: IconName, title: string, description: string): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'mail-empty';
  const mark = document.createElement('div');
  mark.className = 'mail-empty-icon';
  mark.appendChild(icon(iconName, { width: '22', height: '22' }));
  const h = document.createElement('h3');
  h.className = 'mail-empty-title';
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'mail-empty-desc';
  p.textContent = description;
  empty.appendChild(mark);
  empty.appendChild(h);
  empty.appendChild(p);
  return empty;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function avatar(name: string, className = 'mail-avatar'): HTMLElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = mailInitials(name);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/** Map a mail API error to a user-facing i18n key (send/draft paths). */
export function mailErrorKey(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const status = (error as { status?: number } | null)?.status;
  if (status === 501 || code === 'mail_not_implemented') return 'mail.not_ready_send';
  switch (code) {
    case 'mail_external_unavailable':
      return 'mail.external_unavailable';
    case 'mail_quota_exceeded':
      return 'mail.quota_full';
    case 'mail_rate_limited':
      return 'mail.send_rate_limited';
    case 'mail_key_rotated':
      return 'mail.key_rotated';
    case 'mail_too_large':
      return 'mail.attachment_too_large';
    case 'mail_too_many_attachments':
      return 'mail.attachment_too_many';
    case 'mail_not_activated':
      return 'mail.not_activated';
    case 'mail_key_unavailable':
      return 'mail.key_unavailable';
    default:
      return 'mail.send_failed';
  }
}
