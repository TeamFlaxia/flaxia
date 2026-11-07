// Mail compose (docs/mail.md §10). Seals the message client-side and posts only
// ciphertext for internal Flaxia recipients; drafts are encrypted the same way
// and can be reopened from the Drafts folder.
import { t } from '../lib/i18n.js';
import { icon } from '../lib/icons.js';
import { primaryAddressForUsername } from '../lib/mail/address.js';
import { deleteDraft, type MailSecurity } from '../lib/mail/api.js';
import { mailBack } from '../lib/mail/navigation.js';
import { type ComposeAttachmentInput, type ComposeFields, MAX_ATTACHMENTS, MAX_SEND_BYTES } from '../lib/mail/seal.js';
import { openDraft, saveComposeDraft, sendCompose } from '../lib/mail/send.js';
import { formatBytes, mailButton, mailErrorKey, securityChip } from '../lib/mail/ui.js';

export interface MailComposePageProps {
  currentUser: { id: string; username: string } | null;
  draftId?: string;
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
  private form: HTMLFormElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private draftButton: HTMLButtonElement | null = null;
  private draftId = '';
  private busy = false;

  constructor(props: MailComposePageProps) {
    this.props = props;
    this.draftId = props.draftId ?? '';
    this.element = document.createElement('div');
    this.element.className = 'mail-compose-page';
    void this.render();
  }

  private fromAddress(): string {
    if (!this.props.currentUser) return '';
    try {
      return primaryAddressForUsername(this.props.currentUser.username);
    } catch {
      return '';
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
    this.form = form;

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
    this.draftButton = draft;
    toolbar.appendChild(draft);
    if (this.draftId) {
      const remove = mailButton(t('mail.delete_draft') || 'Delete draft', 'ghost', 'trash');
      remove.addEventListener('click', () => void this.removeDraft(remove));
      toolbar.appendChild(remove);
    }
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'mail-compose-status';
    toolbar.appendChild(this.statusEl);
    const send = mailButton(t('mail.send') || 'Send', 'primary', 'send');
    send.type = 'submit';
    this.sendButton = send;
    toolbar.appendChild(send);
    form.appendChild(toolbar);

    this.attachmentsEl = document.createElement('div');
    this.attachmentsEl.className = 'mail-attachment-list';
    form.appendChild(this.attachmentsEl);

    this.element.appendChild(form);
    body.focus();

    if (this.draftId) void this.restore(this.draftId);
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

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.sendButton) this.sendButton.disabled = busy;
    if (this.draftButton) this.draftButton.disabled = busy;
  }

  private async buildFields(form: HTMLFormElement): Promise<ComposeFields> {
    if (this.files.length > MAX_ATTACHMENTS) throw new Error('mail_too_many_attachments');
    let total = 0;
    const attachments: ComposeAttachmentInput[] = [];
    for (const file of this.files) {
      total += file.size;
      if (total > MAX_SEND_BYTES) throw new Error('mail_too_large');
      attachments.push({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    return {
      from: this.fromAddress(),
      to: this.recipients(form, 'to'),
      cc: this.recipients(form, 'cc'),
      bcc: this.recipients(form, 'bcc'),
      subject: this.formValue(form, 'subject'),
      text: this.formValue(form, 'text'),
      attachments,
    };
  }

  private async send(form: HTMLFormElement): Promise<void> {
    if (this.busy) return;
    if (this.recipients(form, 'to').length === 0) {
      this.setStatus(t('mail.no_recipient') || 'Add at least one recipient.');
      return;
    }
    this.setBusy(true);
    this.setStatus(t('mail.sending') || 'Sending…');
    try {
      const fields = await this.buildFields(form);
      await sendCompose(fields, { fromName: this.props.currentUser?.username ?? '' });
      this.setStatus(t('mail.sent') || 'Message sent.');
      mailBack();
    } catch (error) {
      this.setStatus(t(mailErrorKey(error)) || t('mail.send_failed') || 'Could not send the message.');
    } finally {
      this.setBusy(false);
    }
  }

  private async draft(form: HTMLFormElement): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    this.setStatus(t('mail.saving_draft') || 'Saving draft…');
    try {
      const fields = await this.buildFields(form);
      const id = await saveComposeDraft(
        fields,
        { fromName: this.props.currentUser?.username ?? '' },
        this.draftId || undefined,
      );
      this.draftId = id;
      this.setStatus(t('mail.draft_saved') || 'Draft saved.');
    } catch (error) {
      this.setStatus(t(mailErrorKey(error)) || t('mail.save_failed') || 'Could not save the draft.');
    } finally {
      this.setBusy(false);
    }
  }

  private async removeDraft(button: HTMLButtonElement): Promise<void> {
    if (!this.draftId || this.busy) return;
    button.disabled = true;
    try {
      await deleteDraft(this.draftId);
      this.draftId = '';
      mailBack();
    } catch (error) {
      this.setStatus(t(mailErrorKey(error)) || t('mail.save_failed') || 'Could not delete the draft.');
      button.disabled = false;
    }
  }

  private async restore(draftId: string): Promise<void> {
    const form = this.form;
    if (!form) return;
    this.setStatus(t('mail.draft_opening') || 'Opening draft…');
    try {
      const { fields } = await openDraft(draftId);
      const setValue = (name: string, value: string): void => {
        const input = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;
        if (input) input.value = value;
      };
      setValue('to', fields.to.join(', '));
      setValue('cc', fields.cc.join(', '));
      setValue('subject', fields.subject);
      setValue('text', fields.text);
      this.files = fields.attachments.map(
        (attachment) => new File([attachment.bytes as BlobPart], attachment.name, { type: attachment.type }),
      );
      this.renderAttachments();
      this.updateSecurity(form);
      this.setStatus('');
    } catch (error) {
      this.setStatus(t(mailErrorKey(error)) || t('mail.draft_open_failed') || 'This draft could not be opened.');
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
