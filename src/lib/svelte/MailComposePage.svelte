<script lang="ts">
import { primaryAddressForUsername } from '../../../shared/mail-address.ts';
import { t } from '../i18n.ts';
import { deleteDraft, type MailSecurity } from '../mail/api.ts';
import { mailBack } from '../mail/navigation.ts';
import { type ComposeAttachmentInput, type ComposeFields, MAX_ATTACHMENTS, MAX_SEND_BYTES } from '../mail/seal.ts';
import { openDraft, saveComposeDraft, sendCompose } from '../mail/send.ts';
import { formatBytes, mailErrorKey, securityLabel } from '../mail/ui.ts';
import { iconHtml } from '../post/icon-html.ts';

interface Props {
  currentUser: { id: string; username: string } | null;
  draftId?: string;
}

let { currentUser, draftId = '' }: Props = $props();

let to = $state('');
let cc = $state('');
let bcc = $state('');
let subject = $state('');
let text = $state('');
let showCc = $state(false);
let files = $state<File[]>([]);
let status = $state('');
let busy = $state(false);
let savedDraftId = $state(draftId);

const address = $derived.by(() => {
  if (!currentUser) return '';
  try {
    return primaryAddressForUsername(currentUser.username);
  } catch {
    return '';
  }
});

const recipients = $derived(
  [to, cc, bcc]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const security = $derived.by<MailSecurity>(() => {
  if (recipients.length === 0) return 'at_rest';
  return recipients.every((value) => value.endsWith('@flaxia.app')) ? 'e2ee' : 'tls';
});

const hasExternal = $derived(recipients.some((value) => !value.endsWith('@flaxia.app')));

function splitRecipients(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function securityIcon(): string {
  return security === 'e2ee' ? 'shield' : security === 'at_rest' ? 'lock' : 'mail-open';
}

function chipClass(): string {
  return `mail-chip mail-chip--${security.replace('_', '-')}`;
}

function onFilesPicked(event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
  files = Array.from(input.files ?? []);
}

async function buildFields(): Promise<ComposeFields> {
  if (files.length > MAX_ATTACHMENTS) throw new Error('mail_too_many_attachments');
  let total = 0;
  const attachments: ComposeAttachmentInput[] = [];
  for (const file of files) {
    total += file.size;
    if (total > MAX_SEND_BYTES) throw new Error('mail_too_large');
    attachments.push({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return {
    from: address,
    to: splitRecipients(to),
    cc: splitRecipients(cc),
    bcc: splitRecipients(bcc),
    subject,
    text,
    attachments,
  };
}

async function send(): Promise<void> {
  if (busy) return;
  if (splitRecipients(to).length === 0) {
    status = t('mail.no_recipient') || 'Add at least one recipient.';
    return;
  }
  busy = true;
  status = t('mail.sending') || 'Sending…';
  try {
    const fields = await buildFields();
    await sendCompose(fields, { fromName: currentUser?.username ?? '' });
    status = t('mail.sent') || 'Message sent.';
    mailBack();
  } catch (error) {
    status = t(mailErrorKey(error)) || t('mail.send_failed') || 'Could not send the message.';
  } finally {
    busy = false;
  }
}

async function saveDraft(): Promise<void> {
  if (busy) return;
  busy = true;
  status = t('mail.saving_draft') || 'Saving draft…';
  try {
    const fields = await buildFields();
    savedDraftId = await saveComposeDraft(fields, { fromName: currentUser?.username ?? '' }, savedDraftId || undefined);
    status = t('mail.draft_saved') || 'Draft saved.';
  } catch (error) {
    status = t(mailErrorKey(error)) || t('mail.save_failed') || 'Could not save the draft.';
  } finally {
    busy = false;
  }
}

async function removeDraft(): Promise<void> {
  if (!savedDraftId || busy) return;
  busy = true;
  try {
    await deleteDraft(savedDraftId);
    savedDraftId = '';
    mailBack();
  } catch (error) {
    status = t(mailErrorKey(error)) || t('mail.save_failed') || 'Could not delete the draft.';
  } finally {
    busy = false;
  }
}

async function restore(id: string): Promise<void> {
  status = t('mail.draft_opening') || 'Opening draft…';
  try {
    const { fields } = await openDraft(id);
    to = fields.to.join(', ');
    cc = fields.cc.join(', ');
    bcc = '';
    subject = fields.subject;
    text = fields.text;
    files = fields.attachments.map(
      (attachment) => new File([attachment.bytes as BlobPart], attachment.name, { type: attachment.type }),
    );
    status = '';
  } catch (error) {
    status = t(mailErrorKey(error)) || t('mail.draft_open_failed') || 'This draft could not be opened.';
  }
}

// MailView adopts the session in its own onMount; wait for the prop before
// restoring a draft so the composer's address/key state is ready.
let restored = false;
$effect(() => {
  if (!currentUser || restored || !draftId) return;
  restored = true;
  void restore(draftId);
});
</script>

<div class="mail-compose-page">
  <header class="page-header mail-compose-header">
    <button
      type="button"
      class="page-header-back"
      aria-label={t('mail.back') || 'Back to Mail'}
      onclick={() => mailBack()}
    >
      {@html iconHtml('arrow-left', 17)}
    </button>
    <div class="page-header-titles">
      <h1 class="page-header-title">{t('mail.new_message') || 'New message'}</h1>
      <span class="page-header-subtitle">{address}</span>
    </div>
  </header>

  <form
    class="mail-compose-card"
    onsubmit={(event) => {
      event.preventDefault();
      void send();
    }}
  >
    <label class="mail-field">
      <span class="mail-field-label">{t('mail.from') || 'From'}</span>
      <input class="mail-input" type="text" value={address} readonly />
    </label>

    <label class="mail-field">
      <span class="mail-field-label">{t('mail.to') || 'To'}</span>
      <input
        class="mail-input"
        type="text"
        name="to"
        placeholder="name@example.com"
        autocomplete="off"
        aria-label={t('mail.to') || 'To'}
        bind:value={to}
      />
    </label>

    <button type="button" class="mail-cc-toggle" onclick={() => (showCc = !showCc)}>
      {t('mail.cc_bcc') || 'Cc / Bcc'}
    </button>

    <div class="mail-cc-fields" hidden={!showCc}>
      <label class="mail-field">
        <span class="mail-field-label">{t('mail.cc') || 'Cc'}</span>
        <input class="mail-input" type="text" name="cc" aria-label={t('mail.cc') || 'Cc'} bind:value={cc} />
      </label>
      <label class="mail-field">
        <span class="mail-field-label">{t('mail.bcc') || 'Bcc'}</span>
        <input class="mail-input" type="text" name="bcc" aria-label={t('mail.bcc') || 'Bcc'} bind:value={bcc} />
      </label>
    </div>

    <label class="mail-field">
      <span class="mail-field-label">{t('mail.subject') || 'Subject'}</span>
      <input class="mail-input" type="text" name="subject" aria-label={t('mail.subject') || 'Subject'} bind:value={subject} />
    </label>

    <textarea
      class="mail-input mail-compose-body"
      rows="10"
      name="text"
      placeholder={t('mail.body_placeholder') || 'Write your message…'}
      aria-label={t('mail.body_placeholder') || 'Write your message…'}
      bind:value={text}
    ></textarea>

    <div class="mail-compose-security">
      <span class={chipClass()}>
        {@html iconHtml(securityIcon(), 11)}
        <span>{securityLabel(security)}</span>
      </span>
      <p class="mail-compose-warning" hidden={!hasExternal}>
        {t('mail.external_warning') || 'External recipients can read this message. Flaxia encryption does not apply.'}
      </p>
    </div>

    <div class="mail-compose-toolbar">
      <label class="mail-button mail-button--ghost mail-attach-label">
        {@html iconHtml('paperclip', 15)}
        <span>{t('mail.attach') || 'Attach'}</span>
        <input class="mail-file-input" type="file" multiple onchange={onFilesPicked} />
      </label>
      <button type="button" class="mail-button mail-button--secondary" disabled={busy} onclick={() => void saveDraft()}>
        {@html iconHtml('save', 15)}
        <span>{t('mail.save_draft') || 'Save draft'}</span>
      </button>
      {#if savedDraftId}
        <button type="button" class="mail-button mail-button--ghost" disabled={busy} onclick={() => void removeDraft()}>
          {@html iconHtml('trash', 15)}
          <span>{t('mail.delete_draft') || 'Delete draft'}</span>
        </button>
      {/if}
      <span class="mail-compose-status">{status}</span>
      <button type="submit" class="mail-button mail-button--primary" disabled={busy}>
        {@html iconHtml('send', 15)}
        <span>{t('mail.send') || 'Send'}</span>
      </button>
    </div>

    {#if files.length > 0}
      <div class="mail-attachment-list">
        {#each files as file (`${file.name}:${file.size}:${file.lastModified}`)}
          <div class="mail-attachment">
            {@html iconHtml('paperclip', 13)}
            <span>{file.name}</span>
            <span class="mail-attachment-size">{formatBytes(file.size)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </form>
</div>
