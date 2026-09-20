import { t } from '../../lib/i18n.js';
import { loadLinkPreview } from '../../lib/link-preview.js';
import { registerModal } from '../../lib/modal-state.js';
import { showToast } from '../../lib/toast.js';
import { linkifyCustomEmoji, linkifyHashtags, linkifyUrls, processText } from '../PostText.js';
import { closeStampPicker, openStampPicker } from '../StampPicker.js';
import type { ChatMessage, MessageTransport } from './types.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Shared message UI for DM, group and server-channel views.
 *
 * Subclasses build their own surrounding layout (header, member panel, channel
 * list, voice handling, …) but delegate all message rendering, the composer,
 * polling, and send/edit/delete orchestration to this base. The only scope
 * specific behaviour is supplied through a {@link MessageTransport}.
 */
export abstract class MessageView {
  protected element: HTMLElement;
  protected transport!: MessageTransport;
  protected readonly domPrefix: string;

  protected messages: ChatMessage[] = [];
  protected loading = true;
  protected sending = false;
  protected pollTimer: ReturnType<typeof setInterval> | null = null;
  protected nextCursor: string | null = null;
  protected loadingMore = false;
  protected hasMore = true;

  protected selectedFile: File | null = null;
  protected selectedStampId: string | null = null;
  protected editingMsgId: string | null = null;
  protected pendingEnrich: Promise<void>[] = [];

  constructor(domPrefix: string) {
    this.domPrefix = domPrefix;
    this.element = document.createElement('div');
  }

  // ─── element helpers ──────────────────────────────────────────────────────

  protected get messagesArea(): HTMLElement | null {
    return this.element.querySelector(`#${this.domPrefix}-messages-area`);
  }

  protected get inputEl(): HTMLTextAreaElement | null {
    return this.element.querySelector(`#${this.domPrefix}-message-input`);
  }

  protected get sendBtnEl(): HTMLButtonElement | null {
    return this.element.querySelector(`#${this.domPrefix}-send-btn`);
  }

  protected get charCountEl(): HTMLElement | null {
    return this.element.querySelector(`#${this.domPrefix}-char-count`);
  }

  protected get fileInputEl(): HTMLInputElement | null {
    return this.element.querySelector(`#${this.domPrefix}-file-input`);
  }

  protected get filePreviewEl(): HTMLElement | null {
    return this.element.querySelector(`#${this.domPrefix}-file-preview`);
  }

  /** Build the scrollable messages area (id `<prefix>-messages-area`). */
  protected buildMessagesArea(): HTMLElement {
    const area = document.createElement('div');
    area.id = `${this.domPrefix}-messages-area`;
    area.className = 'chat-messages';
    area.addEventListener('scroll', () => {
      if (area.scrollTop < 100 && this.hasMore && !this.loadingMore) {
        void this.loadOlderMessages();
      }
    });
    return area;
  }

  /** Build the standard composer (file button, textarea, send, char count, preview). */
  protected buildComposer(): HTMLElement {
    const inputArea = document.createElement('div');
    inputArea.className = `chat-input-area ${this.domPrefix}-input-area`;

    const fileBtn = document.createElement('button');
    fileBtn.id = `${this.domPrefix}-file-btn`;
    fileBtn.className = 'chat-input-btn';
    fileBtn.textContent = '📎';
    fileBtn.title = t('composer.attach_file');
    fileBtn.addEventListener('click', () => this.fileInputEl?.click());

    const stampBtn = document.createElement('button');
    stampBtn.id = `${this.domPrefix}-stamp-btn`;
    stampBtn.className = 'chat-input-btn';
    stampBtn.textContent = '😀';
    stampBtn.title = t('settings.custom_emoji') || 'Custom Emoji';
    stampBtn.style.cssText = 'font-size: 1.125rem;';
    stampBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.selectedStampId) {
        this.clearStampSelection();
      } else {
        openStampPicker(stampBtn, {
          onSelect: (_emoji: string, stampId?: string) => {
            if (stampId) {
              this.selectedStampId = stampId;
              stampBtn.style.background = 'var(--accent)';
              stampBtn.style.color = 'white';
            }
          },
        });
      }
    });

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = `${this.domPrefix}-file-input`;
    fileInput.style.display = 'none';
    fileInput.accept = this.fileAccept();
    fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.handleFileSelection(file);
    });

    const input = document.createElement('textarea');
    input.id = `${this.domPrefix}-message-input`;
    input.className = `${this.domPrefix}-input chat-input`;
    input.rows = 1;
    input.placeholder = this.inputPlaceholder();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.sendMessage();
      }
    });
    input.addEventListener('input', () => {
      this.updateCharCount();
      this.autoGrow();
    });

    const sendBtn = document.createElement('button');
    sendBtn.id = `${this.domPrefix}-send-btn`;
    sendBtn.className = 'chat-send-btn';
    sendBtn.title = t('messages.send');
    sendBtn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    sendBtn.addEventListener('click', () => void this.sendMessage());

    const charCount = document.createElement('div');
    charCount.id = `${this.domPrefix}-char-count`;
    charCount.className = 'chat-char-count';

    const filePreview = document.createElement('div');
    filePreview.id = `${this.domPrefix}-file-preview`;
    filePreview.className = 'chat-file-preview';
    filePreview.style.display = 'none';
    const filePreviewInfo = document.createElement('span');
    filePreviewInfo.className = `${this.domPrefix}-file-preview-info`;
    const fileRemoveBtn = document.createElement('button');
    fileRemoveBtn.className = 'chat-file-preview-remove';
    fileRemoveBtn.textContent = '✕';
    fileRemoveBtn.addEventListener('click', () => this.clearFileSelection());
    filePreview.appendChild(filePreviewInfo);
    filePreview.appendChild(fileRemoveBtn);

    inputArea.appendChild(fileBtn);
    inputArea.appendChild(stampBtn);
    inputArea.appendChild(fileInput);
    inputArea.appendChild(input);
    inputArea.appendChild(charCount);
    inputArea.appendChild(sendBtn);
    inputArea.appendChild(filePreview);
    return inputArea;
  }

  protected fileAccept(): string {
    return '.gif,.jpg,.jpeg,.png,.webp,.mp3,.wav,.ogg,.m4a,.webm,.zip,.swf';
  }

  protected inputPlaceholder(): string {
    return t('messages.placeholder');
  }

  protected emptyStateText(): string {
    return t('messages.empty');
  }

  /** Whether a send is currently allowed (e.g. a server channel must be active). */
  protected canSend(): boolean {
    return true;
  }

  /** Hook for scope specific state that must reset when a file is cleared. */
  protected resetUploadState(): void {
    /* no-op by default */
  }

  protected clearStampSelection(): void {
    this.selectedStampId = null;
    const stampBtn = this.element.querySelector(`#${this.domPrefix}-stamp-btn`) as HTMLElement | null;
    if (stampBtn) {
      stampBtn.style.background = '';
      stampBtn.style.color = '';
    }
    closeStampPicker();
  }

  // ─── composer behaviour ─────────────────────────────────────────────────────

  protected autoGrow(): void {
    const input = this.inputEl;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  protected updateCharCount(): void {
    const input = this.inputEl;
    const count = this.charCountEl;
    if (input && count) count.textContent = `${input.value.length}/200`;
  }

  protected handleFileSelection(file: File): void {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast(t('composer.error_file_too_large'), true);
      return;
    }
    this.selectedFile = file;
    const preview = this.filePreviewEl;
    const info = this.element.querySelector(`.${this.domPrefix}-file-preview-info`) as HTMLElement | null;
    if (preview && info) {
      info.textContent = file.name;
      preview.style.display = 'flex';
    }
  }

  protected clearFileSelection(): void {
    this.selectedFile = null;
    this.resetUploadState();
    const preview = this.filePreviewEl;
    const input = this.fileInputEl;
    if (preview) preview.style.display = 'none';
    if (input) input.value = '';
  }

  // ─── lifecycle: fetch / poll / read ────────────────────────────────────────

  protected startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.pollNewMessages(), 3000);
  }

  protected stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  protected async pollNewMessages(): Promise<void> {
    if (this.messages.length === 0 || !this.canSend()) return;
    const latest = this.messages[this.messages.length - 1];
    try {
      const newRaw = await this.transport.pollMessages(latest.created_at);
      if (newRaw.length === 0) return;
      const existingIds = new Set(this.messages.map((m) => m.id));
      // The `after` poll returns messages oldest-first, so append in order.
      const added = newRaw.filter((m) => !existingIds.has(m.id));
      if (added.length > 0) {
        this.messages.push(...added);
        this.renderMessages();
        this.scrollToBottom();
        void this.markRead();
      }
    } catch {
      /* ignore polling errors */
    }
  }

  protected async fetchMessages(initial: boolean): Promise<void> {
    this.loading = initial;
    try {
      const data = await this.transport.fetchMessages(this.nextCursor, 50);
      const newMsgs = (data.messages || []).reverse();
      if (initial) this.messages = newMsgs;
      else this.messages = [...newMsgs, ...this.messages];
      this.nextCursor = data.nextCursor;
      this.hasMore = data.nextCursor !== null;

      this.loading = false;
      this.loadingMore = false;
      this.renderMessages();
      if (initial) {
        this.scrollToBottom();
      } else if (newMsgs.length > 0) {
        const firstId = newMsgs[0]?.id;
        if (firstId) {
          requestAnimationFrame(() => {
            this.element.querySelector(`[data-msg-id="${firstId}"]`)?.scrollIntoView({ block: 'start' });
          });
        }
      }
      return;
    } catch {
      /* ignore */
    }
    this.loading = false;
    this.loadingMore = false;
    this.renderMessages();
    if (initial) this.scrollToBottom();
  }

  protected async loadOlderMessages(): Promise<void> {
    if (this.loadingMore || !this.hasMore) return;
    this.loadingMore = true;
    await this.fetchMessages(false);
  }

  protected async markRead(): Promise<void> {
    try {
      await this.transport.markRead();
    } catch {
      /* ignore */
    }
  }

  // ─── send / edit / delete orchestration ────────────────────────────────────

  protected async sendMessage(): Promise<void> {
    const input = this.inputEl;
    const sendBtn = this.sendBtnEl;
    const content = input?.value?.trim() || '';
    if ((!content && !this.selectedFile) || this.sending || !this.canSend()) return;

    this.sending = true;
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.style.opacity = '0.5';
    }

    try {
      if (this.editingMsgId) {
        const patch = await this.transport.editMessage(this.editingMsgId, content);
        if (patch) {
          const idx = this.messages.findIndex((m) => m.id === this.editingMsgId);
          if (idx !== -1) {
            this.messages[idx] = { ...this.messages[idx], ...patch, id: this.messages[idx].id };
          }
          this.renderMessages();
          this.cancelEdit();
        }
      } else {
        const msg = await this.transport.sendMessage({
          content,
          file: this.selectedFile,
          stampId: this.selectedStampId || undefined,
        });
        if (msg) {
          this.messages.push(msg);
          this.renderMessages();
          this.scrollToBottom();
          if (input) input.value = '';
          this.clearFileSelection();
          this.updateCharCount();
          this.autoGrow();
        }
      }
    } catch {
      showToast(t('messages.send_failed'), true);
    }

    this.sending = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.style.opacity = '1';
    }
  }

  protected startEdit(msg: ChatMessage): void {
    if (!msg.is_mine) return;
    this.editingMsgId = msg.id;
    const input = this.inputEl;
    const sendBtn = this.sendBtnEl;
    void this.transport.startEditDecrypt(msg).then((plain) => {
      if (input && this.editingMsgId === msg.id) {
        input.value = plain;
        input.focus();
        this.updateCharCount();
        this.autoGrow();
      }
    });
    if (sendBtn) {
      sendBtn.title = t('messages.save');
      sendBtn.classList.add('chat-send-btn--edit');
    }
  }

  protected cancelEdit(): void {
    this.editingMsgId = null;
    const input = this.inputEl;
    const sendBtn = this.sendBtnEl;
    if (input) input.value = '';
    if (sendBtn) {
      sendBtn.title = t('messages.send');
      sendBtn.classList.remove('chat-send-btn--edit');
    }
    this.updateCharCount();
    this.autoGrow();
  }

  protected async confirmDelete(msg: ChatMessage): Promise<void> {
    this.showDeleteConfirm(msg, async () => {
      const ok = await this.transport.deleteMessage(msg.id);
      if (ok) {
        this.messages = this.messages.filter((m) => m.id !== msg.id);
        this.renderMessages();
      } else {
        showToast(t('messages.delete_failed'), true);
      }
    });
  }

  /** Override to use a scope specific confirmation dialog. */
  protected showDeleteConfirm(msg: ChatMessage, onConfirm: () => void): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;';

    const dialog = document.createElement('div');
    dialog.style.cssText =
      'background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 24px; max-width: 400px; width: 90%;';

    const title = document.createElement('h3');
    title.style.cssText = 'margin: 0 0 16px 0; font-size: 18px; color: var(--text-primary);';
    title.textContent = t('messages.delete_title');

    const message = document.createElement('p');
    message.style.cssText = 'margin: 0 0 24px 0; color: var(--text-muted); font-size: 14px;';
    message.textContent = t('messages.delete_message');

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('common.cancel');
    cancelBtn.style.cssText =
      'padding: 8px 16px; background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); cursor: pointer;';

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = t('common.delete');
    deleteBtn.style.cssText =
      'padding: 8px 16px; background: var(--danger, #e74c3c); border: none; border-radius: 4px; color: #fff; cursor: pointer;';

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(deleteBtn);
    dialog.appendChild(title);
    dialog.appendChild(message);
    dialog.appendChild(buttonRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const destroy = () => {
      unregister();
      overlay.remove();
    };

    cancelBtn.addEventListener('click', destroy);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) destroy();
    });
    deleteBtn.addEventListener('click', () => {
      destroy();
      onConfirm();
    });
  }

  // ─── rendering ──────────────────────────────────────────────────────────────

  protected renderMessages(): void {
    const area = this.messagesArea;
    if (!area) return;
    area.innerHTML = '';
    this.pendingEnrich = [];

    // Collect decryption / enrichment work during the render loop so we can
    // launch it newest-first afterwards (see below). This keeps the most
    // recent messages — the ones the user is actually looking at — decrypting
    // ahead of older history.
    const decryptJobs: Array<{ el: HTMLElement; msg: ChatMessage }> = [];
    const enrichJobs: Array<{ el: HTMLElement; content: string; authorId?: string }> = [];

    if (this.loading && this.messages.length === 0) {
      const loader = document.createElement('div');
      loader.className = 'chat-loading';
      loader.textContent = t('common.loading');
      area.appendChild(loader);
      return;
    }

    if (this.messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = this.emptyStateText();
      area.appendChild(empty);
      return;
    }

    if (this.hasMore) {
      const loadMore = document.createElement('div');
      loadMore.className = 'chat-load-more';
      loadMore.textContent = this.loadingMore ? t('common.loading') : '';
      area.appendChild(loadMore);
    }

    let prevMsg: ChatMessage | null = null;
    let prevDay = '';

    for (const msg of this.messages) {
      const day = new Date(msg.created_at).toDateString();
      if (day !== prevDay) {
        const divider = document.createElement('div');
        divider.className = 'chat-divider';
        const label = document.createElement('span');
        label.className = 'chat-divider-label';
        label.textContent = this.formatDay(msg.created_at);
        divider.appendChild(label);
        area.appendChild(divider);
        prevMsg = null;
      }
      prevDay = day;

      const grouped = this.shouldGroup(prevMsg, msg);
      const row = document.createElement('div');
      row.setAttribute('data-msg-id', msg.id);
      row.className = 'msg-row' + (grouped ? ' msg-row--grouped' : '');

      const avatar = document.createElement('div');
      avatar.className = 'msg-row-avatar';
      if (!grouped && msg.sender?.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${msg.sender.avatar_key})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      } else if (!grouped) {
        avatar.textContent = (msg.sender?.display_name || msg.sender?.username || '?').charAt(0).toUpperCase();
      }

      const content = document.createElement('div');
      content.className = 'msg-row-content';

      if (!grouped) {
        const head = document.createElement('div');
        head.className = 'msg-row-head';
        const username = document.createElement('span');
        username.className = 'msg-row-username';
        username.textContent = msg.sender?.display_name || msg.sender?.username || '?';
        const time = document.createElement('span');
        time.className = 'msg-row-time';
        time.textContent = this.formatClock(msg.created_at);
        head.appendChild(username);
        head.appendChild(time);
        if (msg.edited_at) {
          const edited = document.createElement('span');
          edited.className = 'msg-row-edited';
          edited.textContent = t('messages.edited');
          head.appendChild(edited);
        }
        content.appendChild(head);
      }

      const body = document.createElement('div');
      body.className = 'msg-row-body';

      if (msg.gif_key || msg.payload_key || msg.swf_key) {
        const attachment = document.createElement('div');
        attachment.className = `${this.domPrefix}-bubble-attachment`;
        this.transport.renderAttachment(attachment, msg);
        body.appendChild(attachment);
      }

      if (msg.stamp_url && msg.stamp_name) {
        const stampEl = document.createElement('div');
        stampEl.className = 'msg-row-stamp';
        stampEl.style.cssText = 'margin-bottom: 0.25rem;';
        const stampImg = document.createElement('img');
        stampImg.src = msg.stamp_url;
        stampImg.alt = msg.stamp_name;
        stampImg.style.cssText = 'width: 48px; height: 48px; object-fit: contain;';
        stampEl.appendChild(stampImg);
        body.appendChild(stampEl);
      }

      if (msg.content) {
        const text = document.createElement('div');
        text.className = 'msg-row-text';
        const isEnc = !!msg.enc_version && msg.enc_version > 0;
        if (isEnc) {
          text.textContent = t('messages.encrypted');
          text.classList.add('msg-row-encrypted');
          body.appendChild(text);
          decryptJobs.push({ el: text, msg });
        } else {
          text.textContent = msg.content;
          body.appendChild(text);
          enrichJobs.push({ el: text, content: msg.content, authorId: msg.sender?.id });

          const previewContainer = document.createElement('div');
          previewContainer.className = 'post-link-preview-container';
          previewContainer.style.cssText = 'overflow: hidden;';
          body.appendChild(previewContainer);
          loadLinkPreview(msg.content, previewContainer);
        }
      }

      content.appendChild(body);

      if (msg.is_mine) {
        const actions = document.createElement('div');
        actions.className = 'msg-row-actions';
        const editBtn = document.createElement('button');
        editBtn.className = 'msg-row-action';
        editBtn.textContent = t('messages.edit');
        editBtn.addEventListener('click', () => this.startEdit(msg));
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'msg-row-action msg-row-action--danger';
        deleteBtn.textContent = t('common.delete');
        deleteBtn.addEventListener('click', () => void this.confirmDelete(msg));
        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        content.appendChild(actions);
      }

      row.appendChild(avatar);
      row.appendChild(content);
      area.appendChild(row);

      prevMsg = msg;
    }

    // Kick off decryption / enrichment newest-first so the bottom of the
    // conversation (the latest messages) populates before older history.
    for (let i = decryptJobs.length - 1; i >= 0; i--) {
      this.pendingEnrich.push(this.transport.decryptTextInto(decryptJobs[i].el, decryptJobs[i].msg));
    }
    for (let i = enrichJobs.length - 1; i >= 0; i--) {
      this.pendingEnrich.push(this.enrichText(enrichJobs[i].el, enrichJobs[i].content, enrichJobs[i].authorId));
    }
  }

  protected shouldGroup(prev: ChatMessage | null, curr: ChatMessage): boolean {
    if (!prev) return false;
    if (prev.sender_id !== curr.sender_id) return false;
    if (prev.is_mine !== curr.is_mine) return false;
    const p = new Date(prev.created_at).getTime();
    const c = new Date(curr.created_at).getTime();
    if (new Date(prev.created_at).toDateString() !== new Date(curr.created_at).toDateString()) return false;
    return c - p >= 0 && c - p <= 5 * 60 * 1000;
  }

  protected async enrichText(el: HTMLElement, content: string, authorId?: string): Promise<void> {
    try {
      const html = await processText(content);
      el.innerHTML = html;
      linkifyUrls(el);
      linkifyHashtags(el);
      await linkifyCustomEmoji(el, authorId);
    } catch {
      /* ignore */
    }
  }

  protected formatDay(createdAt: string): string {
    const date = new Date(createdAt);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return t('time.today');
    if (date.toDateString() === yesterday.toDateString()) return t('time.yesterday');
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  protected formatClock(createdAt: string): string {
    return new Date(createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  protected scrollToBottom(): void {
    const area = this.messagesArea;
    if (!area) return;
    // Decryption runs newest-first (see renderMessages) and fills bubbles in
    // the background, so jump to the latest message immediately instead of
    // waiting for the whole history to decrypt.
    this.stabilizeScroll(area, 0);
    if (!this.element.isConnected) return;
    setTimeout(() => {
      if (this.element.isConnected) area.scrollTop = area.scrollHeight;
    }, 300);
    setTimeout(() => {
      if (this.element.isConnected) area.scrollTop = area.scrollHeight;
    }, 1000);
  }

  protected stabilizeScroll(area: HTMLElement, attempts: number): void {
    if (!this.element.isConnected || attempts > 30) return;
    if (area.scrollTop !== area.scrollHeight) {
      area.scrollTop = area.scrollHeight;
      requestAnimationFrame(() => this.stabilizeScroll(area, attempts + 1));
    }
  }

  // ─── public API ─────────────────────────────────────────────────────────────

  public getElement(): HTMLElement {
    return this.element;
  }

  public focusInput(): void {
    const input = this.inputEl;
    if (input) setTimeout(() => input.focus(), 100);
  }

  public destroy(): void {
    this.stopPolling();
    this.element.remove();
  }
}
