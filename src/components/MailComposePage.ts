// Mail compose (docs/mail.md §10). The form is ready for P3; while the send
// endpoint is 501 it reports that clearly instead of pretending to send.
import { t } from '../lib/i18n.js';
import { icon } from '../lib/icons.js';
import { primaryAddressForUsername } from '../lib/mail/address.js';
import { isMailNotImplemented, type MailSecurity, saveDraft, sendMessage } from '../lib/mail/api.js';
import { isMailPreview } from '../lib/mail/demo.js';
import { mailBack } from '../lib/mail/navigation.js';
import { formatBytes, mailButton, securityChip } from '../lib/mail/ui.js';

export interface MailComposePageProps {
  currentUser: { id: string; username: string } | null;
}

export class MailComposePage {
  private element: HTMLElement;
  private props: MailComposePageProps;
  private security: MailSecurity = 'at_rest';
  private statusEl: HTMLElement | null = null;
  private warningEl: HTMLElement | null = null;
  private chipHost: HTMLElement | null = null;
  private attachmentsEl: HTMLElement | null = null;
  private files: File[] = [];

  constructor(props: MailComposePageProps) {
    this.props = props;
    this.element = document.createElement('div');
    this.element.className = 'mail-compose-page';
    void this.render();
  }

  private fromAddress(): string {
    if (!this.props.currentUser) return 'preview@flaxia.app';
    try {
      return primaryAddressForUsername(this.props.currentUser.username);
    } catch {
      return 'preview@flaxia.app';
    }
  }

  private render(): void {
    this.element.replaceChildren();
    const header = document.createElement('header');
    header.className = 'page-header mail-compose-header';
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
    title.className = 'page-header-title';
    title.textContent = t('mail.new_message') || 'New message';
    const subtitle = document.createElement('span');
    subtitle.className = 'page-header-subtitle';
    subtitle.textContent = this.fromAddress();
    titles.appendChild(title);
    titles.appendChild(subtitle);
    header.appendChild(titles);
    this.element.appendChild(header);

    const form = document.createElement('form');
    form.className = 'mail-compose-card';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send(form);
    });

    form.appendChild(this.buildField(t('mail.from') || 'From', this.fromAddress(), true));

    const toInput = this.buildInput(t('mail.to') || 'To', 'to', 'name@example.com');
    form.appendChild(this.wrapField(t('mail.to') || 'To', toInput));
    const ccToggle = document.createElement('button');
    ccToggle.type = 'button';
    ccToggle.className = 'mail-cc-toggle';
    ccToggle.textContent = t('mail.cc_bcc') || 'Cc / Bcc';
    form.appendChild(ccToggle);
    const ccWrap = document.createElement('div');
    ccWrap.className = 'mail-cc-fields';
    ccWrap.hidden = true;
    ccWrap.appendChild(this.wrapField(t('mail.cc') || 'Cc', this.buildInput(t('mail.cc') || 'Cc', 'cc', '')));
    ccWrap.appendChild(this.wrapField(t('mail.bcc') || 'Bcc', this.buildInput(t('mail.bcc') || 'Bcc', 'bcc', '')));
    form.appendChild(ccWrap);
    ccToggle.addEventListener('click', () => {
      ccWrap.hidden = !ccWrap.hidden;
    });

    const subject = this.buildInput(t('mail.subject') || 'Subject', 'subject', '');
    form.appendChild(this.wrapField(t('mail.subject') || 'Subject', subject));

    const body = document.createElement('textarea');
    body.name = 'text';
    body.className = 'mail-input mail-compose-body';
    body.rows = 10;
    body.placeholder = t('mail.body_placeholder') || 'Write your message…';
    body.setAttribute('aria-label', t('mail.body_placeholder') || 'Write your message…');
    form.appendChild(body);

    const securityRow = document.createElement('div');
    securityRow.className = 'mail-compose-security';
    this.chipHost = document.createElement('span');
    this.chipHost.appendChild(securityChip(this.security));
    securityRow.appendChild(this.chipHost);
    this.warningEl = document.createElement('p');
    this.warningEl.className = 'mail-compose-warning';
    this.warningEl.hidden = true;
    this.warningEl.textContent =
      t('mail.external_warning') || 'External recipients can read this message. Flaxia encryption does not apply.';
    securityRow.appendChild(this.warningEl);
    form.appendChild(securityRow);

    for (const input of [
      toInput,
      form.querySelector<HTMLInputElement>('input[name="cc"]'),
      form.querySelector<HTMLInputElement>('input[name="bcc"]'),
    ]) {
      input?.addEventListener('input', () => this.updateSecurity(form));
    }
    this.updateSecurity(form);

    const toolbar = document.createElement('div');
    toolbar.className = 'mail-compose-toolbar';
    const attach = document.createElement('label');
    attach.className = 'mail-button mail-button--ghost mail-attach-label';
    attach.appendChild(icon('paperclip', { width: '15', height: '15' }));
    const attachText = document.createElement('span');
    attachText.textContent = t('mail.attach') || 'Attach';
    attach.appendChild(attachText);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.className = 'mail-file-input';
    fileInput.addEventListener('change', () => {
      this.files = Array.from(fileInput.files ?? []);
      this.renderAttachments();
    });
    attach.appendChild(fileInput);
    toolbar.appendChild(attach);
    const draft = mailButton(t('mail.save_draft') || 'Save draft', 'secondary', 'save');
    draft.addEventListener('click', () => void this.draft(form));
    toolbar.appendChild(draft);
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'mail-compose-status';
    toolbar.appendChild(this.statusEl);
    const send = mailButton(t('mail.send') || 'Send', 'primary', 'send');
    send.type = 'submit';
    toolbar.appendChild(send);
    form.appendChild(toolbar);

    this.attachmentsEl = document.createElement('div');
    this.attachmentsEl.className = 'mail-attachment-list';
    form.appendChild(this.attachmentsEl);

    this.element.appendChild(form);
    body.focus();
  }

  private buildField(labelText: string, value: string, readonly = false): HTMLElement {
    const input = this.buildInput(labelText, '', '');
    input.value = value;
    input.readOnly = readonly;
    return this.wrapField(labelText, input);
  }

  private buildInput(label: string, name: string, placeholder: string): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'mail-input';
    input.name = name;
    input.type = 'text';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', label);
    return input;
  }

  private wrapField(labelText: string, input: HTMLElement): HTMLElement {
    const field = document.createElement('label');
    field.className = 'mail-field';
    const label = document.createElement('span');
    label.className = 'mail-field-label';
    label.textContent = labelText;
    field.appendChild(label);
    field.appendChild(input);
    return field;
  }

  private updateSecurity(form: HTMLFormElement): void {
    const recipients = ['to', 'cc', 'bcc']
      .flatMap((name) => (form.elements.namedItem(name) as HTMLInputElement | null)?.value.split(',') ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const external = recipients.filter((address) => !address.endsWith('@flaxia.app'));
    this.security = recipients.length > 0 && external.length === 0 ? 'e2ee' : external.length > 0 ? 'tls' : 'at_rest';
    if (this.chipHost) {
      this.chipHost.replaceChildren(securityChip(this.security));
    }
    if (this.warningEl) this.warningEl.hidden = external.length === 0;
  }

  private renderAttachments(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.replaceChildren();
    for (const file of this.files) {
      const item = document.createElement('div');
      item.className = 'mail-attachment';
      item.appendChild(icon('paperclip', { width: '13', height: '13' }));
      const name = document.createElement('span');
      name.textContent = file.name;
      const size = document.createElement('span');
      size.className = 'mail-attachment-size';
      size.textContent = formatBytes(file.size);
      item.appendChild(name);
      item.appendChild(size);
      this.attachmentsEl.appendChild(item);
    }
  }

  private formValue(form: HTMLFormElement, name: string): string {
    return (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '';
  }

  private recipients(form: HTMLFormElement, name: 'to' | 'cc' | 'bcc'): string[] {
    return this.formValue(form, name)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private async send(form: HTMLFormElement): Promise<void> {
    const to = this.recipients(form, 'to');
    if (to.length === 0) {
      this.setStatus(t('mail.no_recipient') || 'Add at least one recipient.');
      return;
    }
    if (isMailPreview()) {
      this.setStatus(t('mail.preview_send') || 'Preview mode: the message is not sent.');
      return;
    }
    this.setStatus(t('mail.sending') || 'Sending…');
    try {
      await sendMessage({
        from: this.fromAddress(),
        to,
        cc: this.recipients(form, 'cc'),
        bcc: this.recipients(form, 'bcc'),
        subject: this.formValue(form, 'subject'),
        text: this.formValue(form, 'text'),
        security: this.security,
      });
      this.setStatus(t('mail.sent') || 'Message sent.');
      mailBack();
    } catch (error) {
      this.setStatus(
        isMailNotImplemented(error)
          ? t('mail.not_ready_send') || 'Sending arrives with the next Mail release.'
          : t('mail.send_failed') || 'Could not send the message.',
      );
    }
  }

  private async draft(form: HTMLFormElement): Promise<void> {
    if (isMailPreview()) {
      this.setStatus(t('mail.preview_draft') || 'Preview mode: the draft is not saved.');
      return;
    }
    this.setStatus(t('mail.saving_draft') || 'Saving draft…');
    try {
      await saveDraft({
        from: this.fromAddress(),
        to: this.recipients(form, 'to'),
        cc: this.recipients(form, 'cc'),
        bcc: this.recipients(form, 'bcc'),
        subject: this.formValue(form, 'subject'),
        text: this.formValue(form, 'text'),
      });
      this.setStatus(t('mail.draft_saved') || 'Draft saved.');
    } catch (error) {
      this.setStatus(
        isMailNotImplemented(error)
          ? t('mail.not_ready_draft') || 'Drafts arrive with the next Mail release.'
          : t('mail.save_failed') || 'Could not save the draft.',
      );
    }
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    this.element.remove();
  }
}

export function createMailComposePage(props: MailComposePageProps): MailComposePage {
  return new MailComposePage(props);
}
