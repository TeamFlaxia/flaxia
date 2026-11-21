<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { primaryAddressForUsername } from '../../../shared/mail-address.ts';
import { t } from '../i18n.ts';
import {
  applyMessageAction,
  getThread,
  isMailNotImplemented,
  type MailMessage,
  type MailSecurity,
  type MailThreadDetail,
} from '../mail/api.ts';
import { mailBack } from '../mail/navigation.ts';
import { type DecryptedMessage, MailReader } from '../mail/reader.ts';
import { sendCompose } from '../mail/send.ts';
import { downloadMailAttachment, mountMailHtml } from '../mail/thread-media.ts';
import { formatBytes, formatMailDate, mailErrorKey, mailInitials, securityLabel } from '../mail/ui.ts';
import { mountVaultUnlock } from '../mail/vault-unlock.ts';
import { iconHtml } from '../post/icon-html.ts';
import { isVaultUnlocked, tryDeviceUnlock } from '../vault/session.ts';

interface Props {
  currentUser: { id: string; username: string } | null;
  threadId: string;
}

let { currentUser, threadId }: Props = $props();

type Thread = Pick<MailThreadDetail, 'id' | 'subject' | 'security' | 'labels'> & { messages: MailMessage[] };

let loading = $state(true);
let notReady = $state(false);
let locked = $state(false);
let loadError = $state('');
let thread = $state<Thread | null>(null);
let decryptedMessages: DecryptedMessage[] = [];
let starred = $state(false);
let replyText = $state('');
let replyStatus = $state('');
let replyBusy = $state(false);
let destroyed = false;

const address = $derived.by(() => {
  if (!currentUser) return '';
  try {
    return primaryAddressForUsername(currentUser.username);
  } catch {
    return '';
  }
});

const participants = $derived(
  thread
    ? Array.from(new Set(thread.messages.map((message) => message.from_name || message.from_address))).join(', ')
    : '',
);

function securityIcon(security: MailSecurity): string {
  return security === 'e2ee' ? 'shield' : security === 'at_rest' ? 'lock' : 'mail-open';
}

function chipClass(security: MailSecurity): string {
  return `mail-chip mail-chip--${security.replace('_', '-')}`;
}

function mailHtml(node: HTMLElement, html: string) {
  mountMailHtml(node, html);
  return {
    update(next: string) {
      mountMailHtml(node, next);
    },
  };
}

function vaultUnlock(node: HTMLElement) {
  const form = mountVaultUnlock(node, () => {
    locked = false;
    void loadThread();
  });
  return { destroy: () => form.destroy() };
}

async function loadThread(): Promise<void> {
  if (!currentUser || destroyed) return;
  loading = true;
  notReady = false;
  loadError = '';
  try {
    const encrypted = await getThread(threadId);
    const reader = new MailReader(address);
    const decrypted = await reader.decryptThread(encrypted);
    if (destroyed) return;
    if (!decrypted) {
      loadError = t('mail.key_unavailable') || 'Encrypted mail could not be opened on this device.';
      return;
    }
    decryptedMessages = decrypted.messages;
    const payloadList = await Promise.all(decrypted.messages.map((message) => reader.decryptPayload(message)));
    if (destroyed) return;
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
    thread = {
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
  } catch (error) {
    if (isMailNotImplemented(error)) notReady = true;
    else loadError = t('mail.load_failed') || 'Could not load this thread.';
  } finally {
    if (!destroyed) loading = false;
  }
}

async function init(): Promise<void> {
  if (!currentUser) {
    loading = false;
    return;
  }
  if (!isVaultUnlocked()) await tryDeviceUnlock();
  locked = !isVaultUnlocked();
  if (locked) {
    loading = false;
    return;
  }
  await loadThread();
}

function toggleStar(): void {
  starred = !starred;
  if (!thread) return;
  void applyMessageAction(
    starred ? 'star' : 'unstar',
    thread.messages.map((message) => message.id),
  ).catch(() => undefined);
}

function runAction(action: 'archive' | 'trash'): void {
  if (!thread) return;
  void applyMessageAction(
    action,
    thread.messages.map((message) => message.id),
  )
    .then(() => mailBack())
    .catch((error) => {
      replyStatus = isMailNotImplemented(error)
        ? t('mail.not_ready_action') || 'This action arrives with the next Mail release.'
        : t('mail.action_failed') || 'Could not apply this action.';
    });
}

async function download(
  message: MailMessage,
  attachment: NonNullable<MailMessage['attachments']>[number],
): Promise<void> {
  const source = decryptedMessages.find((entry) => entry.id === message.id);
  if (!source || !attachment.iv) return;
  try {
    await downloadMailAttachment(source, attachment);
  } catch {
    replyStatus = t('mail.attachment_unavailable') || 'This attachment could not be opened.';
  }
}

async function sendReply(): Promise<void> {
  if (!thread || replyBusy) return;
  const text = replyText.trim();
  if (!text) {
    replyStatus = t('mail.empty_message') || 'Write something first.';
    return;
  }
  const last = thread.messages[thread.messages.length - 1];
  const lastDecrypted = decryptedMessages.find((entry) => entry.id === last?.id);
  replyBusy = true;
  try {
    await sendCompose(
      {
        from: address,
        to: last?.from_address ? [last.from_address] : [],
        cc: [],
        bcc: [],
        subject: thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
        text,
        attachments: [],
      },
      {
        fromName: currentUser?.username ?? '',
        threadId: thread.id,
        inReplyToHash: lastDecrypted?.messageIdHash || undefined,
      },
    );
    replyText = '';
    replyStatus = t('mail.reply_sent') || 'Reply sent.';
  } catch (error) {
    replyStatus = t(mailErrorKey(error)) || t('mail.send_failed') || 'Could not send the reply.';
  } finally {
    replyBusy = false;
  }
}

onMount(() => {
  void init();
});

onDestroy(() => {
  destroyed = true;
  for (const message of decryptedMessages) message.contentKey.fill(0);
  decryptedMessages = [];
});
</script>

<div class="mail-thread-page">
  <header class="page-header mail-thread-header">
    <button
      type="button"
      class="page-header-back"
      aria-label={t('mail.back') || 'Back to Mail'}
      onclick={() => mailBack()}
    >
      {@html iconHtml('arrow-left', 17)}
    </button>
    <div class="page-header-titles">
      <h1 class="page-header-title mail-thread-page-title">
        {thread?.subject || t('mail.title') || 'Mail'}
      </h1>
      <span class="page-header-subtitle mail-thread-page-subtitle">
        {thread ? participants : locked ? '' : t('mail.loading') || 'Loading…'}
      </span>
    </div>
    <div class="page-header-actions">
      <button
        type="button"
        class="mail-icon-button mail-star"
        class:mail-star--active={starred}
        aria-label={t('mail.star') || 'Star'}
        aria-pressed={starred}
        onclick={toggleStar}
      >
        {@html iconHtml('star', 18)}
      </button>
      <button
        type="button"
        class="mail-icon-button"
        aria-label={t('mail.archive') || 'Archive'}
        onclick={() => runAction('archive')}
      >
        {@html iconHtml('archive', 18)}
      </button>
      <button
        type="button"
        class="mail-icon-button"
        aria-label={t('mail.delete') || 'Delete'}
        onclick={() => runAction('trash')}
      >
        {@html iconHtml('trash', 18)}
      </button>
    </div>
  </header>

  <div class="mail-thread-body">
    {#if !currentUser}
      <div class="mail-empty">
        <div class="mail-empty-icon">{@html iconHtml('mail', 22)}</div>
        <h3 class="mail-empty-title">{t('mail.requires_login') || 'Sign in to use Mail.'}</h3>
      </div>
    {:else if loading}
      <div class="mail-thread-skeleton">
        {#each [0, 1, 2] as index (index)}
          <div class="mail-message mail-message--skeleton">
            {#each ['32%', '92%', '84%', '65%'] as width (width)}
              <span class="mail-skeleton-line" style={`width: ${width}`}></span>
            {/each}
          </div>
        {/each}
      </div>
    {:else if locked}
      <div class="mail-empty">
        <div class="mail-empty-icon">{@html iconHtml('lock', 22)}</div>
        <h3 class="mail-empty-title">{t('mail.unlock_to_read') || 'Unlock to read mail'}</h3>
        <p class="mail-empty-desc">
          {t('mail.unlock_to_read_desc') ||
            'Your messages are encrypted with the Personal Vault. Unlock it on this device to read this thread.'}
        </p>
        <div use:vaultUnlock></div>
      </div>
    {:else if !thread}
      <div class="mail-empty">
        <div class="mail-empty-icon">{@html iconHtml(notReady ? 'mail-open' : 'warning', 22)}</div>
        <h3 class="mail-empty-title">
          {notReady
            ? t('mail.not_ready_title') || 'Mailbox is getting ready'
            : t('mail.thread_not_found_title') || 'Thread unavailable'}
        </h3>
        <p class="mail-empty-desc">
          {notReady
            ? t('mail.not_ready_desc') ||
              'Reading mail arrives in the next Mail release. Your address and encryption keys are ready.'
            : loadError || t('mail.thread_not_found') || 'This thread could not be found.'}
        </p>
        <button type="button" class="mail-button mail-button--secondary" onclick={() => mailBack()}>
          {@html iconHtml('arrow-left', 15)}
          <span>{t('mail.back_to_mail') || 'Back to Mail'}</span>
        </button>
      </div>
    {:else}
      <div class="mail-thread-intro">
        <h2 class="mail-thread-subject">{thread.subject || t('mail.no_subject') || '(No subject)'}</h2>
        <div class="mail-thread-meta">
          <span class={chipClass(thread.security)}>
            {@html iconHtml(securityIcon(thread.security), 11)}
            <span>{securityLabel(thread.security)}</span>
          </span>
          <span>
            {(t('mail.message_count') || '{count} messages').replace('{count}', String(thread.messages.length))}
          </span>
          {#each thread.labels ?? [] as label (label)}
            <span class="mail-label-chip">{label}</span>
          {/each}
        </div>
      </div>

      {#each thread.messages as message (message.id)}
        <article class="mail-message">
          <div class="mail-message-head">
            <span class="mail-avatar mail-avatar--sm" aria-hidden="true">
              {mailInitials(message.from_name || message.from_address)}
            </span>
            <div class="mail-message-identity">
              <span class="mail-message-name">{message.from_name || message.from_address}</span>
              <span class="mail-message-address">{message.from_address}</span>
            </div>
            <div class="mail-message-right">
              <time class="mail-message-date" datetime={message.date}>{formatMailDate(message.date)}</time>
              <span class={chipClass(message.security)}>
                {@html iconHtml(securityIcon(message.security), 11)}
                <span>{securityLabel(message.security)}</span>
              </span>
            </div>
          </div>

          {#if message.body_html}
            <div class="mail-message-html-host" use:mailHtml={message.body_html}></div>
          {:else}
            <div class="mail-message-body">{message.body_text}</div>
          {/if}

          {#if message.quoted_text}
            <details class="mail-quote">
              <summary>{t('mail.show_quoted') || 'Show quoted text'}</summary>
              <div class="mail-quote-body">{message.quoted_text}</div>
            </details>
          {/if}

          {#if (message.attachments ?? []).length > 0}
            <div class="mail-attachment-list">
              {#each message.attachments ?? [] as attachment (attachment.filename)}
                {@const source = decryptedMessages.find((entry) => entry.id === message.id)}
                <button
                  type="button"
                  class="mail-attachment"
                  class:mail-attachment--unavailable={!source || !attachment.iv}
                  disabled={!source || !attachment.iv}
                  onclick={() => void download(message, attachment)}
                >
                  {@html iconHtml('paperclip', 13)}
                  <span>{attachment.filename}</span>
                  <span class="mail-attachment-size">{formatBytes(attachment.size_bytes)}</span>
                </button>
              {/each}
            </div>
          {/if}
        </article>
      {/each}

      <section class="mail-reply">
        <label class="mail-reply-label" for="mail-reply-input">{t('mail.reply') || 'Reply'}</label>
        <textarea
          id="mail-reply-input"
          class="mail-reply-input"
          rows="4"
          placeholder={t('mail.reply_placeholder') || 'Write a reply…'}
          bind:value={replyText}
        ></textarea>
        <div class="mail-reply-toolbar">
          <span class={chipClass(thread.security)}>
            {@html iconHtml(securityIcon(thread.security), 11)}
            <span>{securityLabel(thread.security)}</span>
          </span>
          <span class="mail-reply-status">{replyStatus}</span>
          <button
            type="button"
            class="mail-button mail-button--primary"
            disabled={replyBusy}
            onclick={() => void sendReply()}
          >
            {@html iconHtml('send', 15)}
            <span>{t('mail.send_reply') || 'Send reply'}</span>
          </button>
        </div>
      </section>
    {/if}
  </div>
</div>
