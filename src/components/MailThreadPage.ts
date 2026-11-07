// Mail thread reader (docs/mail.md §10). Consumes the P2 thread API; when the
// backend is still 501 it shows a calm "getting ready" state instead of an
// error. The preview flag (?mail_preview=1) renders sample messages.
import { t } from '../lib/i18n.js';
import { icon } from '../lib/icons.js';
import { primaryAddressForUsername } from '../lib/mail/address.js';
import {
  applyMessageAction,
  getThread,
  isMailNotImplemented,
  type MailMessage,
  type MailThreadDetail,
} from '../lib/mail/api.js';
import { demoThread, isMailPreview } from '../lib/mail/demo.js';
import { mailBack } from '../lib/mail/navigation.js';
import { type DecryptedMessage, downloadAttachment, MailReader } from '../lib/mail/reader.js';
import { sendCompose } from '../lib/mail/send.js';
import {
  avatar,
  emptyState,
  formatBytes,
  formatMailDate,
  iconButton,
  mailButton,
  mailErrorKey,
  securityChip,
  triggerPop,
} from '../lib/mail/ui.js';
import { getResolvedTheme } from '../lib/theme.js';
import { isVaultUnlocked, tryDeviceUnlock } from '../lib/vault/session.js';
import { createVaultUnlockForm } from './VaultUnlockForm.js';

export interface MailThreadPageProps {
  currentUser: { id: string; username: string } | null;
  threadId: string;
}

export class MailThreadPage {
  private element: HTMLElement;
  private props: MailThreadPageProps;
  private thread: MailThreadDetail | null = null;
  private loading = true;
  private notReady = false;
  private locked = false;
  private loadError: string | null = null;
  private starred = false;
  private bodyEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private subtitleEl: HTMLElement | null = null;
  private replyStatus: HTMLElement | null = null;
  private destroyed = false;
  private decryptedMessages: DecryptedMessage[] = [];

  constructor(props: MailThreadPageProps) {
    this.props = props;
    this.element = document.createElement('div');
    this.element.className = 'mail-thread-page';
    void this.init();
  }

  private async init(): Promise<void> {
    if (!this.props.currentUser) {
      this.renderLogin();
      return;
    }
    this.renderShell();
    const preview = isMailPreview();
    if (preview) {
      this.thread = demoThread(this.props.threadId);
      this.starred = Boolean(this.thread);
      this.loading = false;
      if (!this.thread) this.loadError = t('mail.thread_not_found') || 'This thread could not be found.';
      this.renderBody();
      return;
    }
    if (!isVaultUnlocked()) await tryDeviceUnlock();
    this.locked = !isVaultUnlocked();
    if (this.locked) {
      this.loading = false;
      this.renderBody();
      return;
    }
    try {
      const encrypted = await getThread(this.props.threadId);
      const reader = new MailReader(this.expectedAddress());
      const decrypted = await reader.decryptThread(encrypted);
      if (!decrypted) {
        this.loadError =
          t('mail.key_unavailable') ||
          'Encrypted mail could not be opened on this device. Unlock the vault and try again.';
      } else {
        // Payloads are independent ciphertext blobs; fetch and decrypt them in
        // parallel instead of racing each message round trip back-to-back.
        this.decryptedMessages = decrypted.messages;
        const payloadList = await Promise.all(decrypted.messages.map((message) => reader.decryptPayload(message)));
        const messages: MailMessage[] = decrypted.messages.map((message, index) => {
          const payload = payloadList[index];
          return {
            id: message.id,
            from_name: message.from_name,
            from_address: message.from_address,
            to: message.to,
            date: message.date,
            body_text: payload?.text || t('mail.payload_unavailable') || 'This message could not be decrypted.',
            body_html: payload?.html ?? undefined,
            security: message.security,
            attachments: message.attachments,
          };
        });
        this.thread = {
          id: decrypted.thread.id,
          subject: decrypted.thread.subject,
          security: decrypted.thread.security,
          labels: decrypted.thread.labels,
          messages,
        };
        void applyMessageAction(
          'read',
          messages.map((message) => message.id),
        ).catch(() => undefined);
      }
    } catch (error) {
      if (isMailNotImplemented(error)) this.notReady = true;
      else this.loadError = t('mail.load_failed') || 'Could not load this thread.';
    } finally {
      this.loading = false;
      if (!this.destroyed) this.renderBody();
    }
  }

  private expectedAddress(): string {
    if (!this.props.currentUser) return 'preview@flaxia.app';
    try {
      return primaryAddressForUsername(this.props.currentUser.username);
    } catch {
      return 'preview@flaxia.app';
    }
  }

  private renderLogin(): void {
    this.element.replaceChildren();
    this.element.appendChild(emptyState('mail', t('mail.requires_login') || 'Sign in to use Mail.', ''));
  }

  private renderShell(): void {
    this.element.replaceChildren();
    const header = document.createElement('header');
    header.className = 'page-header mail-thread-header';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'page-header-back';
    back.setAttribute('aria-label', t('mail.back') || 'Back to Mail');
    back.appendChild(icon('arrow-left', { width: '17', height: '17' }));
    back.addEventListener('click', () => mailBack());
    header.appendChild(back);

    const titles = document.createElement('div');
    titles.className = 'page-header-titles';
    const title = document.createElement('h1');
    title.className = 'page-header-title mail-thread-page-title';
    title.textContent = t('mail.title') || 'Mail';
    const subtitle = document.createElement('span');
    subtitle.className = 'page-header-subtitle mail-thread-page-subtitle';
    subtitle.textContent = t('mail.loading') || 'Loading…';
    titles.appendChild(title);
    titles.appendChild(subtitle);
    this.titleEl = title;
    this.subtitleEl = subtitle;
    header.appendChild(titles);

    const actions = document.createElement('div');
    actions.className = 'page-header-actions';
    const star = iconButton('star', t('mail.star') || 'Star', () => {
      this.starred = !this.starred;
      star.classList.toggle('mail-star--active', this.starred);
      star.setAttribute('aria-pressed', String(this.starred));
      triggerPop(star);
      if (!isMailPreview() && this.thread) {
        void applyMessageAction(
          this.starred ? 'star' : 'unstar',
          this.thread.messages.map((message) => message.id),
        ).catch(() => undefined);
      }
    });
    star.classList.add('mail-star');
    actions.appendChild(star);
    actions.appendChild(iconButton('archive', t('mail.archive') || 'Archive', () => this.runAction('archive')));
    actions.appendChild(iconButton('trash', t('mail.delete') || 'Delete', () => this.runAction('trash')));
    header.appendChild(actions);
    this.element.appendChild(header);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'mail-thread-body';
    this.element.appendChild(this.bodyEl);
  }

  private runAction(action: string): void {
    if (!this.thread) return;
    if (isMailPreview()) {
      this.setReplyStatus(t('mail.preview_action') || 'Preview mode: actions are not applied.');
      return;
    }
    void applyMessageAction(
      action,
      this.thread.messages.map((message) => message.id),
    )
      .then(() => mailBack())
      .catch((error) => {
        this.setReplyStatus(
          isMailNotImplemented(error)
            ? t('mail.not_ready_action') || 'This action arrives with the next Mail release.'
            : t('mail.action_failed') || 'Could not apply this action.',
        );
      });
  }

  private renderBody(): void {
    const body = this.bodyEl;
    if (!body) return;
    body.replaceChildren();

    if (this.loading) {
      const skeleton = document.createElement('div');
      skeleton.className = 'mail-thread-skeleton';
      for (let index = 0; index < 3; index += 1) {
        const card = document.createElement('div');
        card.className = 'mail-message mail-message--skeleton';
        for (const width of ['32%', '92%', '84%', '65%']) {
          const line = document.createElement('span');
          line.className = 'mail-skeleton-line';
          line.style.width = width;
          card.appendChild(line);
        }
        skeleton.appendChild(card);
      }
      body.appendChild(skeleton);
      return;
    }

    if (this.locked) {
      const empty = emptyState(
        'lock',
        t('mail.unlock_to_read') || 'Unlock to read mail',
        t('mail.unlock_to_read_desc') ||
          'Your messages are encrypted with the Personal Vault. Unlock it on this device to read this thread.',
      );
      empty.appendChild(
        createVaultUnlockForm({
          onUnlocked: () => {
            this.locked = false;
            void this.init();
          },
        }).getElement(),
      );
      body.appendChild(empty);
      return;
    }

    if (!this.thread) {
      const empty = emptyState(
        this.notReady ? 'mail-open' : 'warning',
        this.notReady
          ? t('mail.not_ready_title') || 'Mailbox is getting ready'
          : t('mail.thread_not_found_title') || 'Thread unavailable',
        this.notReady
          ? t('mail.not_ready_desc') ||
              'Reading mail arrives in the next Mail release. Your address and encryption keys are ready.'
          : this.loadError || t('mail.thread_not_found') || 'This thread could not be found.',
      );
      const back = mailButton(t('mail.back_to_mail') || 'Back to Mail', 'secondary', 'arrow-left');
      back.addEventListener('click', () => mailBack());
      empty.appendChild(back);
      body.appendChild(empty);
      return;
    }

    if (this.titleEl) this.titleEl.textContent = this.thread.subject || t('mail.no_subject') || '(No subject)';
    if (this.subtitleEl) {
      const participants = Array.from(
        new Set(this.thread.messages.map((message) => message.from_name || message.from_address)),
      );
      this.subtitleEl.textContent = participants.join(', ');
    }

    const intro = document.createElement('div');
    intro.className = 'mail-thread-intro';
    const heading = document.createElement('h2');
    heading.className = 'mail-thread-subject';
    heading.textContent = this.thread.subject || t('mail.no_subject') || '(No subject)';
    const meta = document.createElement('div');
    meta.className = 'mail-thread-meta';
    meta.appendChild(securityChip(this.thread.security));
    const count = document.createElement('span');
    count.textContent = (t('mail.message_count') || '{count} messages').replace(
      '{count}',
      String(this.thread.messages.length),
    );
    meta.appendChild(count);
    for (const label of this.thread.labels ?? []) {
      const chip = document.createElement('span');
      chip.className = 'mail-label-chip';
      chip.textContent = label;
      meta.appendChild(chip);
    }
    intro.appendChild(heading);
    intro.appendChild(meta);
    body.appendChild(intro);

    for (const message of this.thread.messages) {
      body.appendChild(this.buildMessage(message));
    }
    body.appendChild(this.buildReply());
  }

  private buildMessage(message: MailMessage): HTMLElement {
    const card = document.createElement('article');
    card.className = 'mail-message';

    const head = document.createElement('div');
    head.className = 'mail-message-head';
    head.appendChild(avatar(message.from_name || message.from_address, 'mail-avatar mail-avatar--sm'));

    const identity = document.createElement('div');
    identity.className = 'mail-message-identity';
    const name = document.createElement('span');
    name.className = 'mail-message-name';
    name.textContent = message.from_name || message.from_address;
    const address = document.createElement('span');
    address.className = 'mail-message-address';
    address.textContent = message.from_address;
    identity.appendChild(name);
    identity.appendChild(address);
    head.appendChild(identity);

    const right = document.createElement('div');
    right.className = 'mail-message-right';
    const date = document.createElement('time');
    date.className = 'mail-message-date';
    date.dateTime = message.date;
    date.textContent = formatMailDate(message.date);
    right.appendChild(date);
    right.appendChild(securityChip(message.security));
    head.appendChild(right);
    card.appendChild(head);

    if (message.body_html) {
      const htmlHost = document.createElement('div');
      htmlHost.className = 'mail-message-html-host';
      card.appendChild(htmlHost);
      void this.mountHtml(htmlHost, message.body_html);
    } else {
      const text = document.createElement('div');
      text.className = 'mail-message-body';
      text.textContent = message.body_text;
      card.appendChild(text);
    }

    if (message.quoted_text) {
      const details = document.createElement('details');
      details.className = 'mail-quote';
      const summary = document.createElement('summary');
      summary.textContent = t('mail.show_quoted') || 'Show quoted text';
      const quoted = document.createElement('div');
      quoted.className = 'mail-quote-body';
      quoted.textContent = message.quoted_text;
      details.appendChild(summary);
      details.appendChild(quoted);
      card.appendChild(details);
    }

    const attachments = message.attachments ?? [];
    if (attachments.length > 0) {
      const list = document.createElement('div');
      list.className = 'mail-attachment-list';
      for (const attachment of attachments) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'mail-attachment';
        item.appendChild(icon('paperclip', { width: '13', height: '13' }));
        const name = document.createElement('span');
        name.textContent = attachment.filename;
        const size = document.createElement('span');
        size.className = 'mail-attachment-size';
        size.textContent = formatBytes(attachment.size_bytes);
        item.appendChild(name);
        item.appendChild(size);
        const source = this.decryptedMessages.find((entry) => entry.id === message.id);
        if (source && attachment.iv) {
          item.addEventListener('click', () => void this.download(source, attachment, item));
        } else {
          item.disabled = true;
          item.classList.add('mail-attachment--unavailable');
        }
        list.appendChild(item);
      }
      card.appendChild(list);
    }

    return card;
  }

  private async mountHtml(host: HTMLElement, html: string): Promise<void> {
    const { createMailRenderer, sanitizeMailHtml } = await import('../lib/mail/render.js');
    const frame = createMailRenderer();
    frame.className = 'mail-message-html';
    frame.title = t('mail.message_body') || 'Message body';
    const dark = getResolvedTheme() === 'dark';
    const colors = dark
      ? 'color:#f8fafc;background:#181d28;a{color:#34d399}'
      : 'color:#0f172a;background:#ffffff;a{color:#047857}';
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.7;${colors}}a{text-decoration:underline}p{margin:0 0 0.75em}img{max-width:100%;height:auto}</style></head><body>${sanitizeMailHtml(html)}</body></html>`;
    host.replaceChildren(frame);
  }

  private buildReply(): HTMLElement {
    const reply = document.createElement('section');
    reply.className = 'mail-reply';
    const label = document.createElement('label');
    label.className = 'mail-reply-label';
    label.textContent = t('mail.reply') || 'Reply';
    const textarea = document.createElement('textarea');
    textarea.className = 'mail-reply-input';
    textarea.rows = 4;
    textarea.placeholder = t('mail.reply_placeholder') || 'Write a reply…';
    label.htmlFor = 'mail-reply-input';
    textarea.id = 'mail-reply-input';
    const toolbar = document.createElement('div');
    toolbar.className = 'mail-reply-toolbar';
    const chip = securityChip(this.thread?.security ?? 'e2ee');
    toolbar.appendChild(chip);
    const status = document.createElement('span');
    status.className = 'mail-reply-status';
    this.replyStatus = status;
    toolbar.appendChild(status);
    const send = mailButton(t('mail.send_reply') || 'Send reply', 'primary', 'send');
    send.addEventListener('click', () => {
      if (!this.thread) return;
      const text = textarea.value.trim();
      if (!text) {
        status.textContent = t('mail.empty_message') || 'Write something first.';
        return;
      }
      if (isMailPreview()) {
        status.textContent = t('mail.preview_send') || 'Preview mode: the reply is not sent.';
        return;
      }
      const last = this.thread.messages[this.thread.messages.length - 1];
      const lastDecrypted = this.decryptedMessages.find((entry) => entry.id === last?.id);
      const to = last?.from_address ? [last.from_address] : [];
      send.disabled = true;
      void sendCompose(
        {
          from: this.expectedAddress(),
          to,
          cc: [],
          bcc: [],
          subject: this.thread.subject.startsWith('Re:') ? this.thread.subject : `Re: ${this.thread.subject}`,
          text,
          attachments: [],
        },
        {
          fromName: this.props.currentUser?.username ?? '',
          threadId: this.thread.id,
          inReplyToHash: lastDecrypted?.messageIdHash || undefined,
        },
      )
        .then(() => {
          textarea.value = '';
          status.textContent = t('mail.reply_sent') || 'Reply sent.';
        })
        .catch((error) => {
          status.textContent = t(mailErrorKey(error)) || t('mail.send_failed') || 'Could not send the reply.';
        })
        .finally(() => {
          send.disabled = false;
        });
    });
    toolbar.appendChild(send);
    reply.appendChild(label);
    reply.appendChild(textarea);
    reply.appendChild(toolbar);
    return reply;
  }

  private async download(
    message: DecryptedMessage,
    attachment: NonNullable<MailMessage['attachments']>[number],
    button: HTMLButtonElement,
  ): Promise<void> {
    button.disabled = true;
    try {
      const bytes = await downloadAttachment(message, attachment);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: attachment.content_type }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = attachment.filename || 'attachment';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      this.setReplyStatus(t('mail.attachment_unavailable') || 'This attachment could not be opened.');
    } finally {
      button.disabled = false;
    }
  }

  private setReplyStatus(text: string): void {
    if (this.replyStatus) this.replyStatus.textContent = text;
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    this.destroyed = true;
    for (const message of this.decryptedMessages) message.contentKey.fill(0);
    this.decryptedMessages = [];
    this.element.remove();
  }
}

export function createMailThreadPage(props: MailThreadPageProps): MailThreadPage {
  return new MailThreadPage(props);
}
