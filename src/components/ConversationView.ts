import { t } from '../lib/i18n.js';
import { showToast } from '../lib/toast.js';

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  gif_key?: string | null;
  payload_key?: string | null;
  swf_key?: string | null;
  created_at: string;
  edited_at?: string | null;
  is_mine: boolean;
  sender: {
    username: string;
    display_name: string;
  };
}

export interface ConversationViewProps {
  conversationId: string;
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  onBack: () => void;
}

export class ConversationView {
  private element: HTMLElement;
  private props: ConversationViewProps;
  private messages: Message[] = [];
  private loading = true;
  private sending = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nextCursor: string | null = null;
  private loadingMore = false;
  private hasMore = true;

  private selectedFile: File | null = null;
  private editingMsgId: string | null = null;

  constructor(props: ConversationViewProps) {
    this.props = props;
    this.element = this.createElement();
    this.loadConversation();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'conversation-view';

    // Header
    const header = document.createElement('div');
    header.className = 'conv-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'conv-header-back';
    backBtn.textContent = '←';
    backBtn.addEventListener('click', () => {
      this.stopPolling();
      this.props.onBack();
    });

    const userAvatar = document.createElement('div');
    userAvatar.id = 'conv-user-avatar';
    userAvatar.className = 'conv-header-avatar';

    const userName = document.createElement('div');
    userName.id = 'conv-user-name';
    userName.className = 'conv-header-name';

    header.appendChild(backBtn);
    header.appendChild(userAvatar);
    header.appendChild(userName);

    // Messages area
    const messagesArea = document.createElement('div');
    messagesArea.id = 'conv-messages-area';
    messagesArea.className = 'conv-messages-area';
    messagesArea.addEventListener('scroll', () => {
      if (messagesArea.scrollTop < 100 && this.hasMore && !this.loadingMore) {
        this.loadOlderMessages();
      }
    });

    // Input area
    const inputArea = document.createElement('div');
    inputArea.className = 'conv-input-area';

    const fileBtn = document.createElement('button');
    fileBtn.id = 'conv-file-btn';
    fileBtn.className = 'conv-file-btn';
    fileBtn.textContent = '📎';
    fileBtn.title = t('composer.attach_file');
    fileBtn.addEventListener('click', () => fileInput.click());

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'conv-file-input';
    fileInput.style.display = 'none';
    fileInput.accept = '.gif,.jpg,.jpeg,.png,.webp,.mp3,.wav,.ogg,.m4a,.webm,.zip,.swf,.jsdos';
    fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.handleFileSelection(file);
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'conv-message-input';
    input.className = 'conv-input';
    input.placeholder = t('messages.placeholder');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    input.addEventListener('input', () => this.updateCharCount());

    const sendBtn = document.createElement('button');
    sendBtn.id = 'conv-send-btn';
    sendBtn.className = 'conv-send-btn';
    sendBtn.textContent = t('messages.send');
    sendBtn.addEventListener('click', () => this.sendMessage());

    const charCount = document.createElement('div');
    charCount.id = 'conv-char-count';
    charCount.className = 'conv-char-count';

    // File preview
    const filePreview = document.createElement('div');
    filePreview.id = 'conv-file-preview';
    filePreview.className = 'conv-file-preview';
    filePreview.style.display = 'none';
    const filePreviewInfo = document.createElement('span');
    filePreviewInfo.className = 'conv-file-preview-info';
    const fileRemoveBtn = document.createElement('button');
    fileRemoveBtn.className = 'conv-file-preview-remove';
    fileRemoveBtn.textContent = '✕';
    fileRemoveBtn.addEventListener('click', () => this.clearFileSelection());
    filePreview.appendChild(filePreviewInfo);
    filePreview.appendChild(fileRemoveBtn);

    inputArea.appendChild(fileBtn);
    inputArea.appendChild(fileInput);
    inputArea.appendChild(input);
    inputArea.appendChild(sendBtn);
    inputArea.appendChild(charCount);
    inputArea.appendChild(filePreview);

    container.appendChild(header);
    container.appendChild(messagesArea);
    container.appendChild(inputArea);

    return container;
  }

  private updateCharCount(): void {
    const input = this.element.querySelector('#conv-message-input') as HTMLInputElement;
    const count = this.element.querySelector('#conv-char-count') as HTMLElement;
    if (input && count) {
      count.textContent = `${input.value.length}/200`;
    }
  }

  private handleFileSelection(file: File): void {
    const maxSize = 25 * 1024 * 1024;
    if (file.size > maxSize) {
      showToast(t('composer.error_file_too_large'), true);
      return;
    }
    this.selectedFile = file;
    const preview = this.element.querySelector('#conv-file-preview') as HTMLElement;
    const info = this.element.querySelector('.conv-file-preview-info') as HTMLElement;
    if (preview && info) {
      info.textContent = file.name;
      preview.style.display = 'flex';
    }
  }

  private clearFileSelection(): void {
    this.selectedFile = null;
    const preview = this.element.querySelector('#conv-file-preview') as HTMLElement;
    const input = this.element.querySelector('#conv-file-input') as HTMLInputElement;
    if (preview) preview.style.display = 'none';
    if (input) input.value = '';
  }

  private async loadConversation(): Promise<void> {
    try {
      const res = await fetch(`/api/dm/conversations/${this.props.conversationId}`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as {
          id: string;
          other_user: { username: string; display_name: string; avatar_key: string | null };
        };

        const avatar = this.element.querySelector('#conv-user-avatar') as HTMLElement;
        const name = this.element.querySelector('#conv-user-name') as HTMLElement;
        if (avatar) {
          if (data.other_user.avatar_key) {
            avatar.style.backgroundImage = `url(/api/images/${data.other_user.avatar_key})`;
            avatar.style.backgroundSize = 'cover';
            avatar.textContent = '';
          } else {
            avatar.textContent = (data.other_user.display_name || data.other_user.username).charAt(0).toUpperCase();
          }
        }
        if (name) {
          name.textContent = data.other_user.display_name || data.other_user.username;
        }
      }
    } catch {
      // ignore
    }

    await this.fetchMessages(true);

    // Mark as read
    try {
      await fetch(`/api/dm/conversations/${this.props.conversationId}/read`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // ignore
    }

    // Start polling for new messages
    this.startPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.pollNewMessages();
    }, 3000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollNewMessages(): Promise<void> {
    if (this.messages.length === 0) return;
    const latestMsg = this.messages[this.messages.length - 1];
    try {
      const res = await fetch(
        `/api/dm/conversations/${this.props.conversationId}/messages?limit=10&cursor=${encodeURIComponent(latestMsg.created_at)}`,
        { credentials: 'include' },
      );
      if (res.ok) {
        const data = (await res.json()) as { messages: Message[]; next_cursor: string | null };
        if (data.messages.length > 0) {
          const existingIds = new Set(this.messages.map((m) => m.id));
          const newMsgs = data.messages.filter((m) => !existingIds.has(m.id)).reverse();
          if (newMsgs.length > 0) {
            this.messages.push(...newMsgs);
            this.renderMessages();
            this.scrollToBottom();

            // Mark as read
            try {
              await fetch(`/api/dm/conversations/${this.props.conversationId}/read`, {
                method: 'POST',
                credentials: 'include',
              });
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore polling errors
    }
  }

  private async fetchMessages(initial: boolean): Promise<void> {
    this.loading = initial;
    try {
      const cursorParam = this.nextCursor ? `&cursor=${encodeURIComponent(this.nextCursor)}` : '';
      const res = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages?limit=50${cursorParam}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { messages: Message[]; next_cursor: string | null };
        // API returns newest first, reverse for display
        const newMsgs = (data.messages || []).reverse();
        if (initial) {
          this.messages = newMsgs;
        } else {
          this.messages = [...newMsgs, ...this.messages];
        }
        this.nextCursor = data.next_cursor;
        this.hasMore = data.next_cursor !== null;

        this.loading = false;
        this.loadingMore = false;
        this.renderMessages();
        if (initial) {
          this.scrollToBottom();
        } else if (newMsgs.length > 0) {
          const firstMsgId = newMsgs[0].id;
          requestAnimationFrame(() => {
            const msgEl = this.element.querySelector(`[data-msg-id="${firstMsgId}"]`) as HTMLElement;
            if (msgEl) msgEl.scrollIntoView({ block: 'start' });
          });
        }
        return;
      }
    } catch {
      // ignore
    }
    this.loading = false;
    this.loadingMore = false;
    this.renderMessages();
    if (initial) {
      this.scrollToBottom();
    }
  }

  private async loadOlderMessages(): Promise<void> {
    if (this.loadingMore || !this.hasMore) return;
    this.loadingMore = true;
    await this.fetchMessages(false);
  }

  private startEdit(msg: Message): void {
    this.editingMsgId = msg.id;
    const input = this.element.querySelector('#conv-message-input') as HTMLInputElement;
    const sendBtn = this.element.querySelector('#conv-send-btn') as HTMLButtonElement;
    if (input) {
      input.value = msg.content;
      input.focus();
      this.updateCharCount();
    }
    if (sendBtn) sendBtn.textContent = t('messages.save');
  }

  private cancelEdit(): void {
    this.editingMsgId = null;
    const input = this.element.querySelector('#conv-message-input') as HTMLInputElement;
    const sendBtn = this.element.querySelector('#conv-send-btn') as HTMLButtonElement;
    if (input) input.value = '';
    if (sendBtn) sendBtn.textContent = t('messages.send');
    this.updateCharCount();
  }

  private async sendMessage(): Promise<void> {
    const input = this.element.querySelector('#conv-message-input') as HTMLInputElement;
    const sendBtn = this.element.querySelector('#conv-send-btn') as HTMLButtonElement;
    const content = input?.value?.trim();
    if ((!content && !this.selectedFile) || this.sending) return;

    this.sending = true;
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
      if (this.editingMsgId) {
        // Edit existing message
        const res = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages/${this.editingMsgId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ content }),
        });

        if (res.ok) {
          const updated = (await res.json()) as { id: string; content: string; edited_at: string };
          const idx = this.messages.findIndex((m) => m.id === updated.id);
          if (idx !== -1) {
            this.messages[idx].content = updated.content;
            this.messages[idx].edited_at = updated.edited_at;
          }
          this.renderMessages();
          this.cancelEdit();
        } else {
          const err = (await res.json()) as { error?: string };
          showToast(err.error || 'Edit failed', true);
        }
        this.sending = false;
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
        return;
      }

      // Send new message
      let gifKey: string | undefined;
      let payloadKey: string | undefined;
      let swfKey: string | undefined;

      // Upload file if selected
      if (this.selectedFile) {
        const prepareRes = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages/prepare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ filename: this.selectedFile.name }),
        });

        if (!prepareRes.ok) {
          const err = (await prepareRes.json()) as { error?: string };
          showToast(err.error || 'Failed to prepare upload', true);
          throw new Error('Prepare failed');
        }

        const prepareData = (await prepareRes.json()) as {
          msgId: string;
          uploadUrl: string;
          storageKey: string;
          gifKey?: string;
          payloadKey?: string;
          swfKey?: string;
        };

        gifKey = prepareData.gifKey;
        payloadKey = prepareData.payloadKey;
        swfKey = prepareData.swfKey;

        // Upload file
        const uploadRes = await fetch(prepareData.uploadUrl, {
          method: 'PUT',
          body: this.selectedFile,
          credentials: 'include',
        });

        if (!uploadRes.ok) {
          showToast('Failed to upload file', true);
          throw new Error('Upload failed');
        }
      }

      // Send message
      const body: Record<string, unknown> = {};
      if (content) body.content = content;
      if (gifKey) body.gifKey = gifKey;
      if (payloadKey) body.payloadKey = payloadKey;
      if (swfKey) body.swfKey = swfKey;

      const res = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const msg = (await res.json()) as Message;
        this.messages.push(msg);
        this.renderMessages();
        this.scrollToBottom();
        input.value = '';
        this.clearFileSelection();
        this.updateCharCount();
      } else {
        const err = (await res.json()) as { error?: string };
        console.error('Send failed:', err.error);
        showToast(err.error || 'Send failed', true);
      }
    } catch {
      console.error('Send failed');
    }

    this.sending = false;
    sendBtn.disabled = false;
    sendBtn.style.opacity = '1';
  }

  private renderMessages(): void {
    const area = this.element.querySelector('#conv-messages-area') as HTMLElement;
    if (!area) return;
    area.innerHTML = '';

    if (this.loading && this.messages.length === 0) {
      const loader = document.createElement('div');
      loader.style.cssText = 'text-align: center; padding: 48px 24px; color: var(--text-muted);';
      loader.textContent = t('common.loading');
      area.appendChild(loader);
      return;
    }

    if (this.messages.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align: center; padding: 48px 24px; color: var(--text-muted);';
      empty.textContent = t('messages.empty');
      area.appendChild(empty);
      return;
    }

    // Load more indicator at top
    if (this.hasMore) {
      const loadMore = document.createElement('div');
      loadMore.style.cssText = 'text-align: center; padding: 8px; color: var(--text-muted); font-size: 12px;';
      loadMore.textContent = this.loadingMore ? t('common.loading') : '';
      area.appendChild(loadMore);
    }

    this.messages.forEach((msg, idx) => {
      const bubble = document.createElement('div');
      bubble.setAttribute('data-msg-id', msg.id);
      bubble.className = `conv-bubble ${msg.is_mine ? 'conv-bubble-mine' : 'conv-bubble-other'}`;

      // Attachment rendering (before text for visual consistency)
      if (msg.gif_key || msg.payload_key || msg.swf_key) {
        const attachment = document.createElement('div');
        attachment.className = 'conv-bubble-attachment';
        this.renderAttachment(attachment, msg);
        bubble.appendChild(attachment);
      }

      // Text content
      if (msg.content) {
        const text = document.createElement('div');
        text.className = `conv-bubble-text ${msg.is_mine ? 'mine' : 'other'}`;
        text.textContent = msg.content;
        bubble.appendChild(text);
      }

      // Time + edited indicator + edit button
      const meta = document.createElement('div');
      meta.className = 'conv-bubble-meta';

      const time = document.createElement('span');
      time.className = 'conv-bubble-time';
      time.textContent = this.formatTime(msg.created_at, idx, msg);

      meta.appendChild(time);

      if (msg.edited_at) {
        const edited = document.createElement('span');
        edited.className = 'conv-bubble-edited';
        edited.textContent = t('messages.edited');
        meta.appendChild(edited);
      }

      if (msg.is_mine) {
        const editBtn = document.createElement('button');
        editBtn.className = 'conv-bubble-edit-btn';
        editBtn.textContent = t('messages.edit');
        editBtn.addEventListener('click', () => this.startEdit(msg));
        meta.appendChild(editBtn);
      }

      bubble.appendChild(meta);
      area.appendChild(bubble);
    });
  }

  private renderAttachment(container: HTMLElement, msg: Message): void {
    const gifKey = msg.gif_key;
    const payloadKey = msg.payload_key;
    const swfKey = msg.swf_key;

    if (gifKey && gifKey.startsWith('dm/audio/')) {
      // Audio player
      const audio = document.createElement('audio');
      audio.className = 'conv-audio-player';
      audio.controls = true;
      audio.preload = 'metadata';
      audio.style.width = '100%';
      audio.style.maxWidth = '300px';
      audio.style.borderRadius = '8px';
      const audioUrl = `/api/audio/${gifKey}`;
      audio.src = audioUrl;
      container.appendChild(audio);
    } else if (gifKey && gifKey.startsWith('dm/gif/')) {
      // Image
      const img = document.createElement('img');
      img.className = 'conv-image-attachment';
      img.loading = 'lazy';
      img.style.cssText = `
        max-width: 100%;
        max-height: 300px;
        border-radius: 12px;
        cursor: pointer;
        display: block;
      `;
      img.src = `/api/images/${gifKey}`;
      img.addEventListener('click', () => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.85); display: flex;
          align-items: center; justify-content: center; z-index: 9999;
          cursor: pointer;
        `;
        const fullImg = document.createElement('img');
        fullImg.src = img.src;
        fullImg.style.cssText = `
          max-width: 90%; max-height: 90%; object-fit: contain;
          border-radius: 8px;
        `;
        overlay.appendChild(fullImg);
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
      });
      container.appendChild(img);
    } else if (payloadKey && payloadKey.startsWith('dm/zip/')) {
      // ZIP file - show download/execute button
      const zipBtn = document.createElement('div');
      zipBtn.className = 'conv-zip-attachment';
      zipBtn.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        padding: 10px 14px; background: var(--bg-secondary);
        border-radius: 12px; cursor: pointer;
        color: var(--text-primary); font-size: 14px;
        max-width: 300px;
      `;
      zipBtn.textContent = '📦 ' + t('messages.open_zip');
      zipBtn.addEventListener('click', () => {
        window.open(`/api/zip/${payloadKey}`, '_blank');
      });
      container.appendChild(zipBtn);
    } else if (swfKey && swfKey.startsWith('dm/swf/')) {
      // SWF file - show play button
      const swfBtn = document.createElement('div');
      swfBtn.className = 'conv-swf-attachment';
      swfBtn.style.cssText = `
        display: flex; align-items: center; gap: 8px;
        padding: 10px 14px; background: var(--bg-secondary);
        border-radius: 12px; cursor: pointer;
        color: var(--text-primary); font-size: 14px;
        max-width: 300px;
      `;
      swfBtn.textContent = '⚡ ' + t('messages.play_flash');
      swfBtn.addEventListener('click', () => {
        window.open(`/api/swf/${swfKey}`, '_blank');
      });
      container.appendChild(swfBtn);
    }
  }

  private formatTime(createdAt: string, _idx: number, _msg: Message): string {
    const date = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return t('messages.just_now');
    if (diffMins < 60) return t('time.minutes_ago', { n: diffMins });

    const hours = date.getHours().toString().padStart(2, '0');
    const mins = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${mins}`;
  }

  private scrollToBottom(): void {
    const area = this.element.querySelector('#conv-messages-area') as HTMLElement;
    if (area) {
      requestAnimationFrame(() => {
        area.scrollTop = area.scrollHeight;
      });
    }
  }

  public focusInput(): void {
    const input = this.element.querySelector('#conv-message-input') as HTMLInputElement;
    if (input) setTimeout(() => input.focus(), 100);
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.stopPolling();
    this.element.remove();
  }
}

export function createConversationView(props: ConversationViewProps): ConversationView {
  return new ConversationView(props);
}
