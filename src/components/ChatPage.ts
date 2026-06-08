import { getMe } from '../lib/auth-cache';
import { t } from '../lib/i18n';

interface ChatUser {
  id: string;
  username: string;
  display_name?: string;
  avatar_key?: string;
}

interface ChatServer {
  id: string;
  name: string;
  description: string;
  icon_key?: string;
  owner_id: string;
  type: 'server' | 'dm';
  created_at: string;
  role?: string;
}

interface ChatChannel {
  id: string;
  server_id: string;
  name: string;
  type: string;
  position: number;
}

interface ChatMessage {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  reply_to_id?: string;
  edited_at?: string;
  pinned: boolean;
  created_at: string;
  author?: {
    username: string;
    display_name?: string;
    avatar_key?: string;
  };
  reactions?: Array<{ emoji: string; user_id: string }>;
}

interface ChatPageProps {
  onNavigate?: (path: string) => void;
}

type Panel = 'servers' | 'channels' | 'messages';

export class ChatPage {
  private element: HTMLElement;
  private currentUser: ChatUser | null = null;
  private servers: ChatServer[] = [];
  private dms: ChatServer[] = [];
  private channels: ChatChannel[] = [];
  private selectedServer: ChatServer | null = null;
  private selectedChannel: ChatChannel | null = null;
  private messages: ChatMessage[] = [];
  private loadingServers = false;
  private loadingChannels = false;
  private loadingMessages = false;
  private sendingMessage = false;
  private ws: WebSocket | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageCursor: string | null = null;
  private hasMoreMessages = true;
  private loadingMore = false;
  private sendTypingTimer: ReturnType<typeof setTimeout> | null = null;

  private serverListEl!: HTMLElement;
  private dmListEl!: HTMLElement;
  private channelListEl!: HTMLElement;
  private messageListEl!: HTMLElement;
  private messageInputEl!: HTMLTextAreaElement;
  private messagePanelEl!: HTMLElement;
  private channelHeaderEl!: HTMLElement;
  private emptyStateEl!: HTMLElement;
  private serverNameEl!: HTMLElement;
  private scrollSentinelEl!: HTMLElement;
  private serverSectionEl!: HTMLElement;
  private dmSectionEl!: HTMLElement;
  private welcomeStateEl!: HTMLElement;
  private addServerBtnEl!: HTMLElement;

  constructor(_props: ChatPageProps = {}) {
    this.element = this.createElement();
    this.init();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'chat-page';

    container.innerHTML = `
      <div class="chat-server-panel">
        <div class="chat-server-section" data-panel="servers">
          <div class="chat-section-header">
            <span class="chat-section-title">${t('chat.servers') || 'Servers'}</span>
          </div>
          <div class="chat-server-list"></div>
          <div class="chat-add-server-btn" title="Create Server">+</div>
        </div>
        <div class="chat-server-section" data-panel="dms">
          <div class="chat-section-header">
            <span class="chat-section-title">${t('chat.dms') || 'Direct Messages'}</span>
          </div>
          <div class="chat-dm-list"></div>
        </div>
      </div>
      <div class="chat-channel-panel">
        <div class="chat-channel-header">
          <span class="chat-server-name"></span>
        </div>
        <div class="chat-channel-list"></div>
      </div>
      <div class="chat-message-panel">
        <div class="chat-channel-header">
          <span class="chat-channel-name"></span>
        </div>
        <div class="chat-message-list"></div>
        <div class="chat-welcome-state">
          <div class="chat-welcome-icon">💬</div>
          <div class="chat-welcome-title">${t('chat.welcome_title') || 'Welcome to Chat!'}</div>
          <div class="chat-welcome-text">${t('chat.welcome_text') || 'Create a server or start a conversation to get started.'}</div>
          <div class="chat-welcome-actions">
            <button class="chat-welcome-create-btn">${t('chat.create_server') || 'Create Server'}</button>
          </div>
        </div>
        <div class="chat-empty-state" style="display:none">
          <div class="chat-empty-icon">💬</div>
          <div class="chat-empty-text">${t('chat.select_channel') || 'Select a channel to start chatting'}</div>
        </div>
        <div class="chat-input-area">
          <div class="chat-input-wrapper">
            <textarea class="chat-input" placeholder="${t('chat.message_placeholder') || 'Type a message...'}" rows="1"></textarea>
            <button class="chat-send-btn" disabled>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;

    this.serverListEl = container.querySelector('.chat-server-list')!;
    this.dmListEl = container.querySelector('.chat-dm-list')!;
    this.channelListEl = container.querySelector('.chat-channel-list')!;
    this.messageListEl = container.querySelector('.chat-message-list')!;
    this.messageInputEl = container.querySelector('.chat-input')!;
    this.messagePanelEl = container.querySelector('.chat-message-panel')!;
    this.channelHeaderEl = container.querySelector('.chat-channel-name')!;
    this.emptyStateEl = container.querySelector('.chat-empty-state')!;
    this.serverNameEl = container.querySelector('.chat-server-name')!;
    this.serverSectionEl = container.querySelector('.chat-server-section[data-panel="servers"]')!;
    this.dmSectionEl = container.querySelector('.chat-server-section[data-panel="dms"]')!;
    this.welcomeStateEl = container.querySelector('.chat-welcome-state')!;
    this.addServerBtnEl = container.querySelector('.chat-add-server-btn')!;

    this.addServerBtnEl.addEventListener('click', () => this.showCreateServerModal());
    this.welcomeStateEl
      .querySelector('.chat-welcome-create-btn')
      ?.addEventListener('click', () => this.showCreateServerModal());

    return container;
  }

  private async init(): Promise<void> {
    const userData = await getMe();
    if (userData) {
      const u = userData.user as Record<string, unknown>;
      this.currentUser = {
        id: u.id as string,
        username: u.username as string,
        display_name: u.display_name as string | undefined,
        avatar_key: u.avatar_key as string | undefined,
      };
    }
    this.loadServers();
    this.setupInputListeners();
  }

  private setupInputListeners(): void {
    this.messageInputEl.addEventListener('input', () => {
      this.messageInputEl.style.height = 'auto';
      this.messageInputEl.style.height = `${Math.min(this.messageInputEl.scrollHeight, 200)}px`;
      const sendBtn = this.element.querySelector('.chat-send-btn') as HTMLButtonElement;
      sendBtn.disabled = !this.messageInputEl.value.trim();
    });

    this.messageInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.element.querySelector('.chat-send-btn')!.addEventListener('click', () => {
      this.sendMessage();
    });
  }

  private async loadServers(): Promise<void> {
    this.loadingServers = true;

    try {
      const [serversRes, dmsRes] = await Promise.all([
        fetch('/api/chat/servers', { credentials: 'include' }),
        fetch('/api/chat/dm', { credentials: 'include' }),
      ]);

      if (serversRes.ok) {
        const data = (await serversRes.json()) as { servers: ChatServer[] };
        this.servers = data.servers || [];
      }
      if (dmsRes.ok) {
        const data = (await dmsRes.json()) as { dms: ChatServer[] };
        this.dms = data.dms || [];
      }
    } catch (e) {
      console.error('Failed to load chat servers:', e);
    }

    this.loadingServers = false;
    this.renderServerList();
    this.updateWelcomeState();
  }

  private updateWelcomeState(): void {
    const hasContent = this.servers.length > 0 || this.dms.length > 0;
    if (hasContent || this.selectedServer) {
      this.welcomeStateEl.style.display = 'none';
    } else {
      this.welcomeStateEl.style.display = 'flex';
      this.messageListEl.style.display = 'none';
      this.emptyStateEl.style.display = 'none';
    }
  }

  private async showCreateServerModal(): Promise<void> {
    const modal = document.createElement('div');
    modal.className = 'chat-modal-overlay';
    modal.innerHTML = `
      <div class="chat-modal">
        <div class="chat-modal-header">${t('chat.create_server') || 'Create Server'}</div>
        <input class="chat-modal-input" type="text" placeholder="${t('chat.server_name_placeholder') || 'Server name'}" maxlength="100">
        <input class="chat-modal-input" type="text" placeholder="${t('chat.server_desc_placeholder') || 'Description (optional)'}" maxlength="500">
        <div class="chat-modal-actions">
          <button class="chat-modal-cancel">${t('chat.cancel') || 'Cancel'}</button>
          <button class="chat-modal-confirm" disabled>${t('chat.create') || 'Create'}</button>
        </div>
      </div>
    `;

    const nameInput = modal.querySelector('.chat-modal-input') as HTMLInputElement;
    const confirmBtn = modal.querySelector('.chat-modal-confirm') as HTMLButtonElement;
    const cancelBtn = modal.querySelector('.chat-modal-cancel') as HTMLButtonElement;

    nameInput.addEventListener('input', () => {
      confirmBtn.disabled = !nameInput.value.trim();
    });

    const closeModal = () => modal.remove();

    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    confirmBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const descInput = modal.querySelectorAll('.chat-modal-input')[1] as HTMLInputElement;
      const description = descInput.value.trim();
      confirmBtn.disabled = true;
      confirmBtn.textContent = t('chat.creating') || 'Creating...';

      try {
        const res = await fetch('/api/chat/servers', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description }),
        });
        if (res.ok) {
          closeModal();
          await this.loadServers();
        } else {
          const err = (await res.json()) as { error: string };
          confirmBtn.textContent = err.error || 'Failed';
          setTimeout(() => {
            confirmBtn.textContent = t('chat.create') || 'Create';
            confirmBtn.disabled = false;
          }, 2000);
        }
      } catch {
        confirmBtn.textContent = 'Error';
        setTimeout(() => {
          confirmBtn.textContent = t('chat.create') || 'Create';
          confirmBtn.disabled = false;
        }, 2000);
      }
    });

    document.body.appendChild(modal);
    setTimeout(() => nameInput.focus(), 100);
  }

  private renderServerList(): void {
    this.serverListEl.innerHTML = '';
    if (this.servers.length === 0) {
      this.serverSectionEl.style.display = 'none';
    } else {
      this.serverSectionEl.style.display = '';
      for (const server of this.servers) {
        const item = document.createElement('div');
        item.className = `chat-server-item${this.selectedServer?.id === server.id ? ' active' : ''}`;
        const initial = server.name.charAt(0).toUpperCase();
        if (server.icon_key) {
          const img = document.createElement('img');
          img.className = 'chat-server-icon-img';
          img.src = `/api/images/${server.icon_key}`;
          img.alt = server.name;
          item.appendChild(img);
        } else {
          item.textContent = initial;
          item.style.backgroundColor = this.stringToColor(server.name);
        }
        item.title = server.name;
        item.addEventListener('click', () => this.selectServer(server));
        this.serverListEl.appendChild(item);
      }
    }

    this.dmListEl.innerHTML = '';
    if (this.dms.length === 0) {
      this.dmSectionEl.style.display = 'none';
    } else {
      this.dmSectionEl.style.display = '';
      for (const dm of this.dms) {
        const item = document.createElement('div');
        item.className = `chat-server-item chat-dm-item${this.selectedServer?.id === dm.id ? ' active' : ''}`;
        const memberCount = 2;
        item.textContent = '💬';
        item.title = dm.name || 'DM';
        item.addEventListener('click', () => this.selectServer(dm));
        this.dmListEl.appendChild(item);
      }
    }
  }

  private stringToColor(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 55%, 45%)`;
  }

  private async selectServer(server: ChatServer): Promise<void> {
    this.selectedServer = server;
    this.selectedChannel = null;
    this.messages = [];
    this.messageCursor = null;
    this.hasMoreMessages = true;
    this.disconnectWs();

    this.serverNameEl.textContent = server.name || 'DM';
    this.channelHeaderEl.textContent = '';
    this.messageListEl.innerHTML = '';
    this.messageListEl.style.display = 'none';
    this.welcomeStateEl.style.display = 'none';
    this.emptyStateEl.style.display = '';
    this.messageInputEl.disabled = true;
    (this.element.querySelector('.chat-send-btn') as HTMLButtonElement).disabled = true;
    this.renderServerList();
    this.loadChannels();
  }

  private async loadChannels(): Promise<void> {
    if (!this.selectedServer) return;
    this.loadingChannels = true;
    this.channelListEl.innerHTML = '<div class="chat-loading">Loading...</div>';

    try {
      const res = await fetch(`/api/chat/servers/${this.selectedServer.id}/channels`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { channels: ChatChannel[] };
        this.channels = data.channels || [];
      } else {
        this.channels = [];
      }
    } catch {
      this.channels = [];
    }

    this.loadingChannels = false;
    this.renderChannelList();
  }

  private renderChannelList(): void {
    this.channelListEl.innerHTML = '';
    for (const ch of this.channels) {
      const item = document.createElement('div');
      item.className = `chat-channel-item${this.selectedChannel?.id === ch.id ? ' active' : ''}`;
      const prefix = ch.type === 'voice' ? '🔊' : '#';
      item.textContent = `${prefix} ${ch.name}`;
      item.addEventListener('click', () => this.selectChannel(ch));
      this.channelListEl.appendChild(item);
    }
  }

  private async selectChannel(channel: ChatChannel): Promise<void> {
    this.selectedChannel = channel;
    this.messages = [];
    this.messageCursor = null;
    this.hasMoreMessages = true;

    this.channelHeaderEl.textContent = `# ${channel.name}`;
    this.messageListEl.innerHTML = '';
    this.messageListEl.style.display = '';
    this.emptyStateEl.style.display = 'none';
    this.messageInputEl.disabled = false;
    this.renderChannelList();
    this.loadMessages();
    this.connectWs();
  }

  private renderMessages(): void {
    this.messageListEl.innerHTML = '';
    if (this.messages.length === 0) {
      this.messageListEl.innerHTML = '<div class="chat-empty-msg">No messages yet</div>';
      return;
    }

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      const prevMsg = i > 0 ? this.messages[i - 1] : null;
      const showHeader =
        !prevMsg || prevMsg.user_id !== msg.user_id || this.timeGapMinutes(prevMsg.created_at, msg.created_at) > 5;
      this.messageListEl.appendChild(this.createMessageElement(msg, showHeader));
    }

    this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
  }

  private timeGapMinutes(a: string, b: string): number {
    return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
  }

  private createMessageElement(msg: ChatMessage, showHeader: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'chat-message';
    el.dataset.messageId = msg.id;

    const isOwn = msg.user_id === this.currentUser?.id;
    const authorName = msg.author?.display_name || msg.author?.username || 'Unknown';
    const time = this.formatTime(msg.created_at);

    if (showHeader) {
      el.innerHTML = `
        <div class="chat-message-avatar">
          ${msg.author?.avatar_key ? `<img src="/api/images/${msg.author.avatar_key}" alt="${authorName}">` : `<div class="chat-avatar-placeholder">${authorName.charAt(0).toUpperCase()}</div>`}
        </div>
        <div class="chat-message-body">
          <div class="chat-message-header">
            <span class="chat-message-author">${authorName}</span>
            <span class="chat-message-time">${time}</span>
          </div>
          <div class="chat-message-content">${this.escapeHtml(msg.content)}</div>
          <div class="chat-message-reactions"></div>
          <div class="chat-message-actions">
            ${isOwn ? `<button class="chat-msg-action chat-edit-btn" title="Edit">✏️</button>` : ''}
            ${isOwn ? `<button class="chat-msg-action chat-delete-btn" title="Delete">🗑️</button>` : ''}
            <button class="chat-msg-action chat-react-btn" title="React">😊</button>
          </div>
        </div>
      `;
    } else {
      el.classList.add('chat-message-continuation');
      el.innerHTML = `
        <div class="chat-message-avatar-placeholder"></div>
        <div class="chat-message-body">
          <div class="chat-message-content">${this.escapeHtml(msg.content)}</div>
          <div class="chat-message-reactions"></div>
          <div class="chat-message-actions">
            ${isOwn ? `<button class="chat-msg-action chat-edit-btn" title="Edit">✏️</button>` : ''}
            ${isOwn ? `<button class="chat-msg-action chat-delete-btn" title="Delete">🗑️</button>` : ''}
            <button class="chat-msg-action chat-react-btn" title="React">😊</button>
          </div>
        </div>
      `;
    }

    if (msg.edited_at) {
      el.querySelector('.chat-message-header')?.insertAdjacentHTML(
        'beforeend',
        '<span class="chat-message-edited">(edited)</span>',
      );
    }

    if (msg.reactions && msg.reactions.length > 0) {
      const reactionList = el.querySelector('.chat-message-reactions')!;
      const grouped = new Map<string, string[]>();
      for (const r of msg.reactions) {
        if (!grouped.has(r.emoji)) grouped.set(r.emoji, []);
        grouped.get(r.emoji)!.push(r.user_id);
      }
      for (const [emoji, users] of grouped) {
        const badge = document.createElement('span');
        badge.className = `chat-reaction-badge${users.includes(this.currentUser?.id || '') ? ' reacted' : ''}`;
        badge.textContent = `${emoji} ${users.length}`;
        badge.addEventListener('click', () => this.toggleReaction(msg, emoji));
        reactionList.appendChild(badge);
      }
    }

    this.setupMessageActions(el, msg);
    return el;
  }

  private setupMessageActions(el: HTMLElement, msg: ChatMessage): void {
    const editBtn = el.querySelector('.chat-edit-btn');
    const deleteBtn = el.querySelector('.chat-delete-btn');
    const reactBtn = el.querySelector('.chat-react-btn');

    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.startEditMessage(msg, el);
      });
    }
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteMessage(msg);
      });
    }
    if (reactBtn) {
      reactBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showReactionPicker(msg, reactBtn as HTMLElement);
      });
    }
  }

  private startEditMessage(msg: ChatMessage, el: HTMLElement): void {
    const contentEl = el.querySelector('.chat-message-content') as HTMLElement;
    const original = msg.content;
    contentEl.innerHTML = `
      <textarea class="chat-edit-input" rows="2">${this.escapeHtml(original)}</textarea>
      <div class="chat-edit-actions">
        <button class="chat-edit-save">Save</button>
        <button class="chat-edit-cancel">Cancel</button>
      </div>
    `;

    const textarea = contentEl.querySelector('textarea')!;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const save = () => {
      const newContent = textarea.value.trim();
      if (newContent && newContent !== original) {
        this.editMessage(msg, newContent, el, contentEl);
      } else {
        contentEl.textContent = this.escapeHtml(original);
      }
    };

    contentEl.querySelector('.chat-edit-save')!.addEventListener('click', save);
    contentEl.querySelector('.chat-edit-cancel')!.addEventListener('click', () => {
      contentEl.textContent = this.escapeHtml(original);
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        save();
      }
      if (e.key === 'Escape') {
        contentEl.textContent = this.escapeHtml(original);
      }
    });
  }

  private async editMessage(msg: ChatMessage, content: string, el: HTMLElement, contentEl: HTMLElement): Promise<void> {
    try {
      const res = await fetch(`/api/chat/messages/${msg.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        contentEl.textContent = this.escapeHtml(content);
        msg.content = content;
        msg.edited_at = new Date().toISOString();
        if (!el.querySelector('.chat-message-edited')) {
          el.querySelector('.chat-message-header')?.insertAdjacentHTML(
            'beforeend',
            '<span class="chat-message-edited">(edited)</span>',
          );
        }
      } else {
        contentEl.textContent = this.escapeHtml(msg.content);
      }
    } catch {
      contentEl.textContent = this.escapeHtml(msg.content);
    }
  }

  private async deleteMessage(msg: ChatMessage): Promise<void> {
    if (!confirm('Delete this message?')) return;
    try {
      const res = await fetch(`/api/chat/messages/${msg.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        this.messages = this.messages.filter((m) => m.id !== msg.id);
        this.renderMessages();
      }
    } catch (e) {
      console.error('Failed to delete message:', e);
    }
  }

  private showReactionPicker(_msg: ChatMessage, _anchor: HTMLElement): void {
    const commonEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉'];
    const existing = this.element.querySelector('.chat-reaction-picker');
    if (existing) existing.remove();
    const picker = document.createElement('div');
    picker.className = 'chat-reaction-picker';
    for (const emoji of commonEmojis) {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.className = 'chat-reaction-option';
      btn.addEventListener('click', () => {
        this.toggleReaction(_msg, emoji);
        picker.remove();
      });
      picker.appendChild(btn);
    }
    _anchor.parentElement?.appendChild(picker);
  }

  private async toggleReaction(msg: ChatMessage, emoji: string): Promise<void> {
    const hasReacted = msg.reactions?.some((r) => r.emoji === emoji && r.user_id === this.currentUser?.id);
    try {
      if (hasReacted) {
        const res = await fetch(`/api/chat/messages/${msg.id}/reactions?emoji=${encodeURIComponent(emoji)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (res.ok) {
          msg.reactions = msg.reactions?.filter((r) => !(r.emoji === emoji && r.user_id === this.currentUser?.id));
        }
      } else {
        const res = await fetch(`/api/chat/messages/${msg.id}/reactions`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji }),
        });
        if (res.ok) {
          if (!msg.reactions) msg.reactions = [];
          msg.reactions.push({ emoji, user_id: this.currentUser?.id || '' });
        }
      }
      this.renderMessages();
    } catch (e) {
      console.error('Failed to toggle reaction:', e);
    }
  }

  private appendMessage(msg: ChatMessage): void {
    const exists = this.messages.some((m) => m.id === msg.id);
    if (exists) return;
    this.messages.push(msg);
    if (this.selectedChannel && msg.channel_id === this.selectedChannel.id) {
      this.messageListEl.appendChild(this.createMessageElement(msg, true));
      this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
    }
  }

  private updateMessageInList(msgId: string, updates: Partial<ChatMessage>): void {
    const idx = this.messages.findIndex((m) => m.id === msgId);
    if (idx === -1) return;
    this.messages[idx] = { ...this.messages[idx], ...updates };
    this.renderMessages();
  }

  private removeMessageFromList(msgId: string): void {
    this.messages = this.messages.filter((m) => m.id !== msgId);
    this.renderMessages();
  }

  private async loadMessages(): Promise<void> {
    if (!this.selectedChannel) return;
    this.loadingMessages = true;
    try {
      const params = new URLSearchParams({ limit: '50' });
      const res = await fetch(`/api/chat/channels/${this.selectedChannel.id}/messages?${params}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { messages: ChatMessage[] };
        this.messages = (data.messages || []).reverse();
        this.hasMoreMessages = this.messages.length >= 50;
      }
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
    this.loadingMessages = false;
    this.renderMessages();
    this.markChannelRead();
  }

  private async markChannelRead(): Promise<void> {
    if (!this.selectedChannel) return;
    const lastMsg = this.messages[this.messages.length - 1];
    if (!lastMsg) return;
    try {
      await fetch(`/api/chat/channels/${this.selectedChannel.id}/read`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_message_id: lastMsg.id }),
      });
    } catch {}
  }

  private async sendMessage(): Promise<void> {
    if (!this.selectedChannel || this.sendingMessage) return;
    const content = this.messageInputEl.value.trim();
    if (!content) return;

    this.sendingMessage = true;
    const sendBtn = this.element.querySelector('.chat-send-btn') as HTMLButtonElement;
    sendBtn.disabled = true;

    try {
      const res = await fetch(`/api/chat/channels/${this.selectedChannel.id}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        this.messageInputEl.value = '';
        this.messageInputEl.style.height = 'auto';
        const data = (await res.json()) as { message: ChatMessage };
        if (data.message) {
          this.appendMessage(data.message);
        }
      }
    } catch (e) {
      console.error('Failed to send message:', e);
    }

    this.sendingMessage = false;
    sendBtn.disabled = false;
  }

  private connectWs(): void {
    this.disconnectWs();
    if (!this.selectedServer) return;

    const token = localStorage.getItem('flaxia_session');
    if (!token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws/chat?token=${encodeURIComponent(token)}&server_id=${this.selectedServer.id}`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleWsEvent(data);
        } catch {}
      };
      this.ws.onclose = () => {
        this.ws = null;
        this.scheduleWsReconnect();
      };
      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleWsReconnect();
    }
  }

  private scheduleWsReconnect(): void {
    if (this.wsReconnectTimer) return;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.connectWs();
    }, 5000);
  }

  private disconnectWs(): void {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private handleWsEvent(data: Record<string, unknown>): void {
    switch (data.type) {
      case 'message_created': {
        const msg = data.message as ChatMessage;
        if (msg && msg.channel_id === this.selectedChannel?.id) {
          this.appendMessage(msg);
          this.markChannelRead();
        }
        break;
      }
      case 'message_updated':
        if (this.selectedChannel) {
          this.updateMessageInList(data.message_id as string, {
            content: data.content as string,
            edited_at: new Date().toISOString(),
          });
        }
        break;
      case 'message_deleted':
        this.removeMessageFromList(data.message_id as string);
        break;
      case 'reaction_added':
      case 'reaction_removed':
        this.refreshMessages();
        break;
    }
  }

  private async refreshMessages(): Promise<void> {
    if (!this.selectedChannel) return;
    try {
      const params = new URLSearchParams({ limit: '50' });
      const res = await fetch(`/api/chat/channels/${this.selectedChannel.id}/messages?${params}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const data = (await res.json()) as { messages: ChatMessage[] };
        this.messages = (data.messages || []).reverse();
        this.renderMessages();
      }
    } catch {}
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  private formatTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.disconnectWs();
  }
}

export function createChatPage(props: ChatPageProps = {}): ChatPage {
  return new ChatPage(props);
}
