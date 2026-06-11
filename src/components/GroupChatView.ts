import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';
import { showToast } from '../lib/toast.js';
import { executeZipAuto } from '../lib/zip-manager.js';
import { createAudioPlayer } from './AudioPlayer.js';
import { executeFlash } from './FlashPlayer.js';
import { createImagePreview } from './ImagePreview.js';

export interface GroupMessage {
  id: string;
  group_id: string;
  sender_id: string;
  content: string;
  gif_key?: string | null;
  payload_key?: string | null;
  swf_key?: string | null;
  created_at: string;
  edited_at?: string | null;
  is_mine: boolean;
  sender: {
    id: string;
    username: string;
    display_name: string;
    avatar_key: string | null;
  };
}

export interface GroupMember {
  id: string;
  username: string;
  display_name: string;
  avatar_key: string | null;
  role: string;
  joined_at: string;
}

export interface GroupChatViewProps {
  groupId: string;
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  onBack: () => void;
}

export class GroupChatView {
  private element: HTMLElement;
  private props: GroupChatViewProps;
  private messages: GroupMessage[] = [];
  private loading = true;
  private sending = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nextCursor: string | null = null;
  private loadingMore = false;
  private hasMore = true;
  private groupName = '';
  private myRole = '';
  private members: GroupMember[] = [];

  private selectedFile: File | null = null;
  private editingMsgId: string | null = null;

  constructor(props: GroupChatViewProps) {
    this.props = props;
    this.element = this.createElement();
    this.loadGroup();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'group-chat-view';

    // Header
    const header = document.createElement('div');
    header.className = 'group-chat-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'group-chat-header-back';
    backBtn.textContent = '←';
    backBtn.addEventListener('click', () => {
      this.stopPolling();
      this.props.onBack();
    });

    const groupAvatar = document.createElement('div');
    groupAvatar.id = 'group-chat-avatar';
    groupAvatar.className = 'group-chat-header-avatar';

    const groupInfo = document.createElement('div');
    groupInfo.className = 'group-chat-header-info';

    const groupName = document.createElement('div');
    groupName.id = 'group-chat-name';
    groupName.className = 'group-chat-header-name';

    const groupMeta = document.createElement('div');
    groupMeta.id = 'group-chat-meta';
    groupMeta.className = 'group-chat-header-meta';

    groupInfo.appendChild(groupName);
    groupInfo.appendChild(groupMeta);

    const membersBtn = document.createElement('button');
    membersBtn.className = 'group-chat-members-btn';
    membersBtn.textContent = t('groups.members');
    membersBtn.addEventListener('click', () => this.showMembersModal());

    header.appendChild(backBtn);
    header.appendChild(groupAvatar);
    header.appendChild(groupInfo);

    // Call button
    const callBtn = document.createElement('button');
    callBtn.className = 'group-call-btn';
    callBtn.title = 'Voice call';
    callBtn.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    callBtn.addEventListener('click', () => {
      const event = new CustomEvent('startGroupCall', {
        detail: { groupId: this.props.groupId },
      });
      window.dispatchEvent(event);
    });
    header.appendChild(callBtn);

    header.appendChild(membersBtn);

    // Messages area
    const messagesArea = document.createElement('div');
    messagesArea.id = 'group-messages-area';
    messagesArea.className = 'group-messages-area';
    messagesArea.addEventListener('scroll', () => {
      if (messagesArea.scrollTop < 100 && this.hasMore && !this.loadingMore) {
        this.loadOlderMessages();
      }
    });

    // Input area
    const inputArea = document.createElement('div');
    inputArea.className = 'group-input-area';

    const fileBtn = document.createElement('button');
    fileBtn.id = 'group-file-btn';
    fileBtn.className = 'group-file-btn';
    fileBtn.textContent = '📎';
    fileBtn.title = t('composer.attach_file');
    fileBtn.addEventListener('click', () => fileInput.click());

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'group-file-input';
    fileInput.style.display = 'none';
    fileInput.accept = '.gif,.jpg,.jpeg,.png,.webp,.mp3,.wav,.ogg,.m4a,.webm,.zip,.swf,.jsdos';
    fileInput.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) this.handleFileSelection(file);
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'group-message-input';
    input.className = 'group-input';
    input.placeholder = t('groups.placeholder');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    input.addEventListener('input', () => this.updateCharCount());

    const sendBtn = document.createElement('button');
    sendBtn.id = 'group-send-btn';
    sendBtn.className = 'group-send-btn';
    sendBtn.textContent = t('messages.send');
    sendBtn.addEventListener('click', () => this.sendMessage());

    const charCount = document.createElement('div');
    charCount.id = 'group-char-count';
    charCount.className = 'group-char-count';

    // File preview
    const filePreview = document.createElement('div');
    filePreview.id = 'group-file-preview';
    filePreview.className = 'group-file-preview';
    filePreview.style.display = 'none';
    const filePreviewInfo = document.createElement('span');
    filePreviewInfo.className = 'group-file-preview-info';
    const fileRemoveBtn = document.createElement('button');
    fileRemoveBtn.className = 'group-file-preview-remove';
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
    const input = this.element.querySelector('#group-message-input') as HTMLInputElement;
    const count = this.element.querySelector('#group-char-count') as HTMLElement;
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
    const preview = this.element.querySelector('#group-file-preview') as HTMLElement;
    const info = this.element.querySelector('.group-file-preview-info') as HTMLElement;
    if (preview && info) {
      info.textContent = file.name;
      preview.style.display = 'flex';
    }
  }

  private clearFileSelection(): void {
    this.selectedFile = null;
    const preview = this.element.querySelector('#group-file-preview') as HTMLElement;
    const input = this.element.querySelector('#group-file-input') as HTMLInputElement;
    if (preview) preview.style.display = 'none';
    if (input) input.value = '';
  }

  private async loadGroup(): Promise<void> {
    try {
      const res = await fetch(`/api/groups/${this.props.groupId}`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as {
          id: string;
          name: string;
          description: string;
          icon_key: string | null;
          my_role: string;
          members: GroupMember[];
        };

        this.groupName = data.name;
        this.myRole = data.my_role;
        this.members = data.members || [];

        const avatar = this.element.querySelector('#group-chat-avatar') as HTMLElement;
        const name = this.element.querySelector('#group-chat-name') as HTMLElement;
        const meta = this.element.querySelector('#group-chat-meta') as HTMLElement;

        if (avatar) {
          if (data.icon_key) {
            avatar.style.backgroundImage = `url(/api/images/${data.icon_key})`;
            avatar.style.backgroundSize = 'cover';
            avatar.textContent = '';
          } else {
            avatar.textContent = data.name.charAt(0).toUpperCase();
          }
        }
        if (name) name.textContent = data.name;
        if (meta) meta.textContent = `${data.members.length} members`;
      }
    } catch {
      // ignore
    }

    await this.fetchMessages(true);

    // Mark as read
    try {
      await fetch(`/api/groups/${this.props.groupId}/read`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // ignore
    }

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
        `/api/groups/${this.props.groupId}/messages?limit=10&cursor=${encodeURIComponent(latestMsg.created_at)}`,
        { credentials: 'include' },
      );
      if (res.ok) {
        const data = (await res.json()) as { messages: GroupMessage[]; next_cursor: string | null };
        if (data.messages.length > 0) {
          const existingIds = new Set(this.messages.map((m) => m.id));
          const newMsgs = data.messages.filter((m) => !existingIds.has(m.id)).reverse();
          if (newMsgs.length > 0) {
            this.messages.push(...newMsgs);
            this.renderMessages();
            this.scrollToBottom();

            try {
              await fetch(`/api/groups/${this.props.groupId}/read`, {
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
      const res = await fetch(`/api/groups/${this.props.groupId}/messages?limit=50${cursorParam}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { messages: GroupMessage[]; next_cursor: string | null };
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
    if (initial) this.scrollToBottom();
  }

  private async loadOlderMessages(): Promise<void> {
    if (this.loadingMore || !this.hasMore) return;
    this.loadingMore = true;
    await this.fetchMessages(false);
  }

  private startEdit(msg: GroupMessage): void {
    this.editingMsgId = msg.id;
    const input = this.element.querySelector('#group-message-input') as HTMLInputElement;
    const sendBtn = this.element.querySelector('#group-send-btn') as HTMLButtonElement;
    if (input) {
      input.value = msg.content;
      input.focus();
      this.updateCharCount();
    }
    if (sendBtn) sendBtn.textContent = t('messages.save');
  }

  private cancelEdit(): void {
    this.editingMsgId = null;
    const input = this.element.querySelector('#group-message-input') as HTMLInputElement;
    const sendBtn = this.element.querySelector('#group-send-btn') as HTMLButtonElement;
    if (input) input.value = '';
    if (sendBtn) sendBtn.textContent = t('messages.send');
    this.updateCharCount();
  }

  private async sendMessage(): Promise<void> {
    const input = this.element.querySelector('#group-message-input') as HTMLInputElement;
    const sendBtn = this.element.querySelector('#group-send-btn') as HTMLButtonElement;
    const content = input?.value?.trim();
    if ((!content && !this.selectedFile) || this.sending) return;

    this.sending = true;
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
      if (this.editingMsgId) {
        const res = await fetch(`/api/groups/${this.props.groupId}/messages/${this.editingMsgId}`, {
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

      let gifKey: string | undefined;
      let payloadKey: string | undefined;
      let swfKey: string | undefined;
      let messageId: string | undefined;

      if (this.selectedFile) {
        const prepareRes = await fetch(`/api/groups/${this.props.groupId}/messages/prepare`, {
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

        messageId = prepareData.msgId;
        gifKey = prepareData.gifKey;
        payloadKey = prepareData.payloadKey;
        swfKey = prepareData.swfKey;

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

      const body: Record<string, unknown> = {};
      if (content) body.content = content;
      if (gifKey) body.gifKey = gifKey;
      if (payloadKey) body.payloadKey = payloadKey;
      if (swfKey) body.swfKey = swfKey;
      if (messageId) body.messageId = messageId;

      const res = await fetch(`/api/groups/${this.props.groupId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const msg = (await res.json()) as GroupMessage;
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
    const area = this.element.querySelector('#group-messages-area') as HTMLElement;
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
      empty.textContent = t('groups.empty');
      area.appendChild(empty);
      return;
    }

    if (this.hasMore) {
      const loadMore = document.createElement('div');
      loadMore.style.cssText = 'text-align: center; padding: 8px; color: var(--text-muted); font-size: 12px;';
      loadMore.textContent = this.loadingMore ? t('common.loading') : '';
      area.appendChild(loadMore);
    }

    // Group messages by sender for display
    this.messages.forEach((msg) => {
      const bubble = document.createElement('div');
      bubble.setAttribute('data-msg-id', msg.id);
      bubble.className = `group-bubble ${msg.is_mine ? 'group-bubble-mine' : 'group-bubble-other'}`;

      // Show sender info for other users' messages
      if (!msg.is_mine) {
        const senderInfo = document.createElement('div');
        senderInfo.className = 'group-bubble-sender';

        const senderAvatar = document.createElement('div');
        senderAvatar.className = 'group-bubble-sender-avatar';
        if (msg.sender.avatar_key) {
          senderAvatar.style.backgroundImage = `url(/api/images/${msg.sender.avatar_key})`;
          senderAvatar.style.backgroundSize = 'cover';
          senderAvatar.textContent = '';
        } else {
          senderAvatar.textContent = (msg.sender.display_name || msg.sender.username).charAt(0).toUpperCase();
        }

        const senderName = document.createElement('span');
        senderName.className = 'group-bubble-sender-name';
        senderName.textContent = msg.sender.display_name || msg.sender.username;

        senderInfo.appendChild(senderAvatar);
        senderInfo.appendChild(senderName);
        bubble.appendChild(senderInfo);
      }

      // Attachment rendering
      if (msg.gif_key || msg.payload_key || msg.swf_key) {
        const attachment = document.createElement('div');
        attachment.className = 'group-bubble-attachment';
        this.renderAttachment(attachment, msg);
        bubble.appendChild(attachment);
      }

      // Text content
      if (msg.content) {
        const text = document.createElement('div');
        text.className = `group-bubble-text ${msg.is_mine ? 'mine' : 'other'}`;
        text.textContent = msg.content;
        bubble.appendChild(text);
      }

      // Time + edited indicator + edit/delete buttons
      const meta = document.createElement('div');
      meta.className = 'group-bubble-meta';

      const time = document.createElement('span');
      time.className = 'group-bubble-time';
      time.textContent = this.formatTime(msg.created_at);

      meta.appendChild(time);

      if (msg.edited_at) {
        const edited = document.createElement('span');
        edited.className = 'group-bubble-edited';
        edited.textContent = t('messages.edited');
        meta.appendChild(edited);
      }

      if (msg.is_mine) {
        const editBtn = document.createElement('button');
        editBtn.className = 'group-bubble-edit-btn';
        editBtn.textContent = t('messages.edit');
        editBtn.addEventListener('click', () => this.startEdit(msg));
        meta.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'group-bubble-delete-btn';
        deleteBtn.textContent = t('common.delete');
        deleteBtn.addEventListener('click', () => this.confirmDelete(msg));
        meta.appendChild(deleteBtn);
      }

      bubble.appendChild(meta);
      area.appendChild(bubble);
    });
  }

  private renderAttachment(container: HTMLElement, msg: GroupMessage): void {
    const gifKey = msg.gif_key;
    const payloadKey = msg.payload_key;
    const swfKey = msg.swf_key;

    if (gifKey && gifKey.startsWith('group/audio/')) {
      const player = createAudioPlayer({ gifKey, postId: msg.id });
      player.style.maxWidth = '300px';
      container.appendChild(player);
    } else if (gifKey && gifKey.startsWith('group/gif/')) {
      const preview = createImagePreview({ gifKey, postId: msg.id });
      preview.style.maxWidth = '100%';
      container.appendChild(preview);
    } else if (payloadKey && payloadKey.startsWith('group/zip/')) {
      this.renderZipAttachment(container, msg);
    } else if (swfKey && swfKey.startsWith('group/swf/')) {
      this.renderSwfAttachment(container, msg);
    }
  }

  private renderZipAttachment(container: HTMLElement, msg: GroupMessage): void {
    const btn = document.createElement('div');
    btn.className = 'execution-button';
    btn.style.cssText = `
      display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 16px 24px; cursor: pointer;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; border-radius: 12px; font-weight: 600; font-size: 15px;
      max-width: 300px; transition: all 0.2s ease;
    `;
    btn.innerHTML = '<span style="font-size:24px">📦</span> ' + t('messages.open_zip');
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.02)';
      btn.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', () => this.executeZipModal(msg));
    container.appendChild(btn);
  }

  private renderSwfAttachment(container: HTMLElement, msg: GroupMessage): void {
    const btn = document.createElement('div');
    btn.className = 'execution-button';
    btn.style.cssText = `
      display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 16px 24px; cursor: pointer;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; border-radius: 12px; font-weight: 600; font-size: 15px;
      max-width: 300px; transition: all 0.2s ease;
    `;
    btn.innerHTML = '<span style="font-size:24px">⚡</span> ' + t('messages.play_flash');
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.02)';
      btn.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', () => this.executeSwfModal(msg));
    container.appendChild(btn);
  }

  private executeZipModal(msg: GroupMessage): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85); display: flex;
      align-items: center; justify-content: center; z-index: 9999;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      width: 90%; max-width: 800px; height: 80vh;
      background: #fff; border-radius: 12px; overflow: hidden;
      position: relative; display: flex; flex-direction: column;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 16px; background: #f5f5f5;
    `;

    const title = document.createElement('span');
    title.style.cssText = 'font-weight: 600; font-size: 14px; color: #333;';
    title.textContent = t('messages.open_zip');

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      background: none; border: none; font-size: 18px; cursor: pointer;
      color: #666; padding: 4px 8px;
    `;
    closeBtn.addEventListener('click', () => destroy());

    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.style.cssText = 'flex: 1; position: relative; background: #fff;';

    modal.appendChild(header);
    modal.appendChild(content);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const destroy = () => {
      unregister();
      overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) destroy();
    });

    executeZipAuto(msg.id, content).catch((err) => {
      console.error('ZIP execution failed:', err);
      content.innerHTML =
        '<div style="padding: 40px; text-align: center; color: #666;">' + t('post_stage.zip_load_error') + '</div>';
    });
  }

  private executeSwfModal(msg: GroupMessage): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85); display: flex;
      align-items: center; justify-content: center; z-index: 9999;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      width: 90%; max-width: 800px; height: 80vh;
      background: #fff; border-radius: 12px; overflow: hidden;
      position: relative; display: flex; flex-direction: column;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 16px; background: #f5f5f5;
    `;

    const title = document.createElement('span');
    title.style.cssText = 'font-weight: 600; font-size: 14px; color: #333;';
    title.textContent = t('messages.play_flash');

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      background: none; border: none; font-size: 18px; cursor: pointer;
      color: #666; padding: 4px 8px;
    `;
    closeBtn.addEventListener('click', () => destroy());

    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.style.cssText =
      'flex: 1; position: relative; background: #000; display: flex; align-items: center; justify-content: center;';

    modal.appendChild(header);
    modal.appendChild(content);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const destroy = () => {
      unregister();
      overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) destroy();
    });

    executeFlash(msg.id, content).catch((err) => {
      console.error('Flash execution failed:', err);
      content.innerHTML =
        '<div style="padding: 40px; text-align: center; color: #999;">' + t('post_stage.flash_load_error') + '</div>';
    });
  }

  private confirmDelete(msg: GroupMessage): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); display: flex;
      align-items: center; justify-content: center; z-index: 1000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--bg-primary); border: 1px solid var(--border);
      border-radius: 8px; padding: 24px; max-width: 400px; width: 90%;
    `;

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

    deleteBtn.addEventListener('click', async () => {
      destroy();
      try {
        const res = await fetch(`/api/groups/${this.props.groupId}/messages/${msg.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (res.ok) {
          this.messages = this.messages.filter((m) => m.id !== msg.id);
          this.renderMessages();
        } else {
          const err = (await res.json()) as { error?: string };
          showToast(err.error || 'Delete failed', true);
        }
      } catch {
        showToast('Delete failed', true);
      }
    });
  }

  private showMembersModal(): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); display: flex;
      align-items: center; justify-content: center; z-index: 1000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--bg-primary); border: 1px solid var(--border);
      border-radius: 12px; padding: 24px; max-width: 400px; width: 90%;
      max-height: 80vh; display: flex; flex-direction: column;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 16px;
    `;

    const title = document.createElement('h3');
    title.style.cssText = 'margin: 0; font-size: 18px; color: var(--text-primary);';
    title.textContent = `${this.groupName} - ${t('groups.members')}`;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      background: none; border: none; font-size: 18px; cursor: pointer;
      color: var(--text-muted); padding: 4px;
    `;
    closeBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Add member button (owner/admin only)
    const canManage = this.myRole === 'owner' || this.myRole === 'admin';
    const addSection = document.createElement('div');
    if (canManage) {
      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.placeholder = t('groups.search_users');
      addInput.style.cssText = `
        width: 100%; padding: 8px 12px; border: 1px solid var(--border);
        border-radius: 6px; background: var(--bg-secondary); color: var(--text-primary);
        font-size: 13px; font-family: inherit; outline: none; box-sizing: border-box;
        margin-bottom: 8px;
      `;

      const addResults = document.createElement('div');
      addResults.id = 'group-add-member-results';
      addResults.style.cssText = 'max-height: 150px; overflow-y: auto; margin-bottom: 8px;';

      let addTimer: ReturnType<typeof setTimeout> | null = null;
      addInput.addEventListener('input', () => {
        if (addTimer) clearTimeout(addTimer);
        addTimer = setTimeout(async () => {
          const q = addInput.value.trim();
          if (q.length < 1) {
            addResults.innerHTML = '';
            return;
          }
          try {
            const res = await fetch(`/api/users/suggest?q=${encodeURIComponent(q)}`, { credentials: 'include' });
            if (res.ok) {
              const data = (await res.json()) as {
                users: Array<{ id: string; username: string; display_name: string }>;
              };
              const existingIds = new Set(this.members.map((m) => m.id));
              addResults.innerHTML = '';
              (data.users || [])
                .filter((u) => !existingIds.has(u.id) && u.id !== this.props.currentUser?.id)
                .forEach((u) => {
                  const row = document.createElement('div');
                  row.style.cssText = `
                    padding: 8px; cursor: pointer; border-radius: 6px;
                    display: flex; align-items: center; gap: 8px; font-size: 13px;
                  `;
                  row.addEventListener('mouseenter', () => {
                    row.style.background = 'var(--bg-secondary)';
                  });
                  row.addEventListener('mouseleave', () => {
                    row.style.background = '';
                  });
                  row.textContent = `${u.display_name || u.username} (@${u.username})`;
                  row.addEventListener('click', async () => {
                    try {
                      const r = await fetch(`/api/groups/${this.props.groupId}/members`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ memberIds: [u.id] }),
                      });
                      if (r.ok) {
                        showToast(t('groups.member_added'));
                        addResults.innerHTML = '';
                        addInput.value = '';
                        // Refresh members
                        this.loadGroup();
                      }
                    } catch {
                      /* ignore */
                    }
                  });
                  addResults.appendChild(row);
                });
            }
          } catch {
            /* ignore */
          }
        }, 300);
      });

      addSection.appendChild(addInput);
      addSection.appendChild(addResults);
    }

    const memberList = document.createElement('div');
    memberList.style.cssText = 'overflow-y: auto; flex: 1;';

    this.members.forEach((member) => {
      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; align-items: center; gap: 10px; padding: 8px 4px;
        border-radius: 6px;
      `;

      const avatar = document.createElement('div');
      avatar.style.cssText = `
        width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
        background: var(--accent); display: flex; align-items: center;
        justify-content: center; color: #000; font-weight: 600; font-size: 14px;
        overflow: hidden;
      `;
      if (member.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${member.avatar_key})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      } else {
        avatar.textContent = (member.display_name || member.username).charAt(0).toUpperCase();
      }

      const info = document.createElement('div');
      info.style.cssText = 'flex: 1; min-width: 0;';
      const name = document.createElement('div');
      name.style.cssText = 'color: var(--text-primary); font-weight: 500; font-size: 14px;';
      name.textContent = member.display_name || member.username;
      const role = document.createElement('span');
      role.style.cssText = 'color: var(--text-muted); font-size: 11px; margin-left: 6px;';
      role.textContent = member.role === 'owner' ? '👑' : member.role === 'admin' ? '🔧' : '';

      const handle = document.createElement('div');
      handle.style.cssText = 'color: var(--text-muted); font-size: 12px;';
      handle.textContent = `@${member.username}`;

      name.appendChild(role);
      info.appendChild(name);
      info.appendChild(handle);

      row.appendChild(avatar);
      row.appendChild(info);

      // Remove button (if can manage and not owner)
      if (canManage && member.id !== this.props.currentUser?.id && member.role !== 'owner') {
        const removeBtn = document.createElement('button');
        removeBtn.textContent = t('common.delete');
        removeBtn.style.cssText = `
          padding: 4px 8px; font-size: 11px; background: none;
          border: 1px solid var(--border); border-radius: 4px;
          color: var(--text-muted); cursor: pointer;
        `;
        removeBtn.addEventListener('click', async () => {
          try {
            const r = await fetch(`/api/groups/${this.props.groupId}/members/${member.id}`, {
              method: 'DELETE',
              credentials: 'include',
            });
            if (r.ok) {
              showToast(t('groups.member_removed'));
              this.loadGroup();
            }
          } catch {
            /* ignore */
          }
        });
        row.appendChild(removeBtn);
      }

      // Leave button for self
      if (member.id === this.props.currentUser?.id && member.role !== 'owner') {
        const leaveBtn = document.createElement('button');
        leaveBtn.textContent = t('groups.leave');
        leaveBtn.style.cssText = `
          padding: 4px 8px; font-size: 11px; background: none;
          border: 1px solid var(--danger, #e74c3c); border-radius: 4px;
          color: var(--danger, #e74c3c); cursor: pointer;
        `;
        leaveBtn.addEventListener('click', async () => {
          try {
            const r = await fetch(`/api/groups/${this.props.groupId}/members/${member.id}`, {
              method: 'DELETE',
              credentials: 'include',
            });
            if (r.ok) {
              unregister();
              overlay.remove();
              this.props.onBack();
            }
          } catch {
            /* ignore */
          }
        });
        row.appendChild(leaveBtn);
      }

      memberList.appendChild(row);
    });

    dialog.appendChild(header);
    dialog.appendChild(addSection);
    dialog.appendChild(memberList);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });
  }

  private formatTime(createdAt: string): string {
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
    const area = this.element.querySelector('#group-messages-area') as HTMLElement;
    if (area) {
      requestAnimationFrame(() => {
        area.scrollTop = area.scrollHeight;
      });
    }
  }

  public focusInput(): void {
    const input = this.element.querySelector('#group-message-input') as HTMLInputElement;
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

export function createGroupChatView(props: GroupChatViewProps): GroupChatView {
  return new GroupChatView(props);
}
