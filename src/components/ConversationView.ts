import { t } from '../lib/i18n.js';

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
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

    inputArea.appendChild(input);
    inputArea.appendChild(sendBtn);
    inputArea.appendChild(charCount);

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

  private async sendMessage(): Promise<void> {
    const input = this.element.querySelector('#conv-message-input') as HTMLInputElement;
    const sendBtn = this.element.querySelector('#conv-send-btn') as HTMLButtonElement;
    const content = input?.value?.trim();
    if (!content || this.sending) return;

    this.sending = true;
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
      const res = await fetch(`/api/dm/conversations/${this.props.conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content }),
      });

      if (res.ok) {
        const msg = (await res.json()) as Message;
        this.messages.push(msg);
        this.renderMessages();
        this.scrollToBottom();
        input.value = '';
        this.updateCharCount();
      } else {
        const err = (await res.json()) as { error?: string };
        console.error('Send failed:', err.error);
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

      const text = document.createElement('div');
      text.className = `conv-bubble-text ${msg.is_mine ? 'mine' : 'other'}`;
      text.textContent = msg.content;

      const time = document.createElement('div');
      time.className = 'conv-bubble-time';
      time.textContent = this.formatTime(msg.created_at, idx, msg);

      bubble.appendChild(text);
      bubble.appendChild(time);
      area.appendChild(bubble);
    });
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
