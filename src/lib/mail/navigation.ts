import { navigate } from '../navigation.js';

export type MailView = 'mail' | 'mail-thread' | 'mail-compose' | 'mail-settings';

/** Navigate inside the Mail surface without a full reload (keeps VK in memory). */
export function goToMailView(_view: MailView, path: string, postId?: string): void {
  void navigate(path, { state: postId ? { postId } : {} });
}

export function goToMail(): void {
  goToMailView('mail', '/mail');
}

export function goToMailThread(id: string): void {
  goToMailView('mail-thread', `/mail/thread/${encodeURIComponent(id)}`, id);
}

// Draft ids ride in-memory: the compose route has no stable path segment, and a
// hard reload of /mail/compose should open a blank composer.
let pendingDraftId = '';

export function goToMailCompose(draftId?: string): void {
  pendingDraftId = draftId ?? '';
  goToMailView('mail-compose', '/mail/compose');
}

export function takePendingDraftId(): string {
  const id = pendingDraftId;
  pendingDraftId = '';
  return id;
}

export function goToMailSettings(): void {
  goToMailView('mail-settings', '/mail/settings');
}

/** Every Mail surface returns to the mailbox list. */
export function mailBack(): void {
  void navigate('/mail');
}
