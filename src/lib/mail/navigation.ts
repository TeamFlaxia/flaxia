import { goBackInSpaOr, pushSpaHistory } from '../spa-history.js';

export type MailView = 'mail' | 'mail-thread' | 'mail-compose' | 'mail-settings';

/** Navigate inside the Mail surface without a full reload (keeps VK in memory). */
export function goToMailView(view: MailView, path: string, postId?: string): void {
  pushSpaHistory(path, postId ? { postId } : {});
  window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view, postId } }));
}

export function goToMail(): void {
  goToMailView('mail', '/mail');
}

export function goToMailThread(id: string): void {
  goToMailView('mail-thread', `/mail/thread/${encodeURIComponent(id)}`, id);
}

export function goToMailCompose(): void {
  goToMailView('mail-compose', '/mail/compose');
}

export function goToMailSettings(): void {
  goToMailView('mail-settings', '/mail/settings');
}

export function mailBack(fallback: MailView = 'mail'): void {
  const paths: Record<MailView, string> = {
    mail: '/mail',
    'mail-thread': '/mail',
    'mail-compose': '/mail',
    'mail-settings': '/mail',
  };
  goBackInSpaOr(() => goToMailView(fallback, paths[fallback]));
}
