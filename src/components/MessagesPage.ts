import { t } from '../lib/i18n.js';

export interface Conversation {
  id: string;
  other_user: {
    id: string;
    username: string;
    display_name: string;
    avatar_key: string | null;
  };
  last_message: {
    id: string;
    content: string;
    sender_id: string;
    created_at: string;
    is_mine: boolean;
  } | null;
  unread: boolean;
  updated_at: string;
}

export interface MessagesPageProps {
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  onNavigateToConversation: (convId: string) => void;
}

export class MessagesPage {
  private element: HTMLElement;
  private props: MessagesPageProps;
  private conversations: Conversation[] = [];
  private loading = true;
  private searchResults: Array<{ id: string; username: string; display_name: string; avatar_key: string | null }> = [];
  private showSearch = false;
  private searchInputValue = '';
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: MessagesPageProps) {
    this.props = props;
    this.element = this.createElement();
    this.fetchConversations();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'messages-page';

    // Header
    const header = document.createElement('div');
    header.className = 'messages-page-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'messages-page-back';
    backBtn.textContent = '←';
    backBtn.addEventListener('mouseenter', () => {
      backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
    });
    backBtn.addEventListener('mouseleave', () => {
      backBtn.style.background = '';
    });
    backBtn.addEventListener('click', () => {
      window.history.back();
    });

    const title = document.createElement('h1');
    title.textContent = t('messages.title');

    const newBtn = document.createElement('button');
    newBtn.className = 'messages-page-new-btn';
    newBtn.textContent = `+ ${t('messages.new')}`;
    newBtn.addEventListener('click', () => {
      this.toggleSearch();
    });

    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(newBtn);

    // Search area (hidden by default)
    const searchArea = document.createElement('div');
    searchArea.id = 'messages-search-area';
    searchArea.style.cssText = `
      display: none;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
    `;

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'messages-search-input';
    searchInput.placeholder = t('messages.search_user_placeholder');
    searchInput.style.cssText = `
      width: 100%;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 14px;
      font-family: inherit;
      outline: none;
      box-sizing: border-box;
    `;
    // Input stays inline for dynamic value handling
    searchInput.addEventListener('input', () => {
      this.searchInputValue = searchInput.value;
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.searchUsers(searchInput.value), 300);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggleSearch();
    });

    searchArea.appendChild(searchInput);

    // Search results
    const searchResults = document.createElement('div');
    searchResults.id = 'messages-search-results';
    searchResults.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 1px;
    `;
    searchArea.appendChild(searchResults);

    // Content area (placeholder updates dynamically)
    const content = document.createElement('div');
    content.id = 'messages-content';
    content.style.cssText = `
      display: flex;
      flex-direction: column;
    `;

    container.appendChild(header);
    container.appendChild(searchArea);
    container.appendChild(content);

    return container;
  }

  private toggleSearch(): void {
    this.showSearch = !this.showSearch;
    const searchArea = this.element.querySelector('#messages-search-area') as HTMLElement;
    const searchInput = this.element.querySelector('#messages-search-input') as HTMLInputElement;
    if (this.showSearch) {
      searchArea.style.display = '';
      setTimeout(() => searchInput?.focus(), 100);
    } else {
      searchArea.style.display = 'none';
      this.searchResults = [];
      this.searchInputValue = '';
      this.renderSearchResults();
    }
  }

  private async searchUsers(query: string): Promise<void> {
    if (!query || query.length < 1) {
      this.searchResults = [];
      this.renderSearchResults();
      return;
    }

    try {
      const res = await fetch(`/api/users/suggest?q=${encodeURIComponent(query)}`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as {
          users: Array<{ id: string; username: string; display_name: string; avatar_key: string | null }>;
        };
        this.searchResults = data.users || [];
      }
    } catch {
      this.searchResults = [];
    }
    this.renderSearchResults();
  }

  private renderSearchResults(): void {
    const container = this.element.querySelector('#messages-search-results') as HTMLElement;
    if (!container) return;
    container.innerHTML = '';

    if (this.searchResults.length === 0 && this.searchInputValue.length > 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding: 16px; color: var(--text-muted); text-align: center;';
      empty.textContent = t('messages.search_no_results');
      container.appendChild(empty);
      return;
    }

    this.searchResults.forEach((user) => {
      const row = document.createElement('div');
      row.style.cssText = `
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 8px;
        cursor: pointer;
        border-radius: 8px;
        transition: background 0.15s ease;
      `;
      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--bg-secondary)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = '';
      });
      row.addEventListener('click', () => this.startConversation(user.id));

      const avatar = document.createElement('div');
      avatar.style.cssText = `
        width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
        background: var(--accent); display: flex; align-items: center; justify-content: center;
        color: #000; font-weight: 600; font-size: 16px;
        overflow: hidden;
      `;
      if (user.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${user.avatar_key})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      } else {
        avatar.textContent = (user.display_name || user.username).charAt(0).toUpperCase();
      }

      const info = document.createElement('div');
      info.style.cssText = 'flex: 1; min-width: 0;';
      const name = document.createElement('div');
      name.style.cssText = 'color: var(--text-primary); font-weight: 500; font-size: 15px;';
      name.textContent = user.display_name || user.username;
      const handle = document.createElement('div');
      handle.style.cssText = 'color: var(--text-muted); font-size: 13px;';
      handle.textContent = `@${user.username}`;
      info.appendChild(name);
      info.appendChild(handle);

      row.appendChild(avatar);
      row.appendChild(info);
      container.appendChild(row);
    });
  }

  private async startConversation(otherUserId: string): Promise<void> {
    try {
      const res = await fetch('/api/dm/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: otherUserId }),
      });
      if (res.ok) {
        const data = (await res.json()) as { id: string };
        this.toggleSearch();
        this.props.onNavigateToConversation(data.id);
      }
    } catch (e) {
      console.error('Failed to create conversation:', e);
    }
  }

  private async fetchConversations(): Promise<void> {
    this.loading = true;
    try {
      const res = await fetch('/api/dm/conversations', { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { conversations: Conversation[] };
        this.conversations = data.conversations || [];
      }
    } catch {
      this.conversations = [];
    }
    this.loading = false;
    this.renderList();
  }

  private renderList(): void {
    const content = this.element.querySelector('#messages-content') as HTMLElement;
    if (!content) return;
    content.innerHTML = '';

    if (this.loading) {
      const loader = document.createElement('div');
      loader.style.cssText = 'text-align: center; padding: 48px 24px; color: var(--text-muted);';
      loader.textContent = t('common.loading');
      content.appendChild(loader);
      return;
    }

    if (this.conversations.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align: center; padding: 48px 24px; color: var(--text-muted);';
      empty.textContent = t('messages.no_conversations');
      content.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.style.cssText = 'display: flex; flex-direction: column;';

    this.conversations.forEach((conv) => {
      const row = document.createElement('div');
      row.className = 'messages-conv-row';
      row.style.background = conv.unread ? 'var(--bg-secondary)' : 'var(--bg-primary)';
      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--bg-tertiary, #f0f0f0)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = conv.unread ? 'var(--bg-secondary)' : 'var(--bg-primary)';
      });
      row.addEventListener('click', () => this.props.onNavigateToConversation(conv.id));

      const avatar = document.createElement('div');
      avatar.className = 'messages-conv-avatar';
      if (conv.other_user.avatar_key) {
        avatar.style.backgroundImage = `url(/api/images/${conv.other_user.avatar_key})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      } else {
        avatar.textContent = (conv.other_user.display_name || conv.other_user.username).charAt(0).toUpperCase();
      }

      const info = document.createElement('div');
      info.className = 'messages-conv-info';

      const topRow = document.createElement('div');
      topRow.className = 'messages-conv-top';

      const name = document.createElement('div');
      name.className = `messages-conv-name ${conv.unread ? 'unread' : 'read'}`;
      name.textContent = conv.other_user.display_name || conv.other_user.username;

      const time = document.createElement('div');
      time.className = 'messages-conv-time';
      if (conv.last_message) {
        time.textContent = this.formatTime(conv.last_message.created_at);
      }

      topRow.appendChild(name);
      topRow.appendChild(time);

      const preview = document.createElement('div');
      preview.className = `messages-conv-preview ${conv.unread ? 'unread' : 'read'}`;
      if (conv.last_message) {
        const prefix = conv.last_message.is_mine ? 'You: ' : '';
        preview.textContent = `${prefix}${conv.last_message.content}`;
      }

      info.appendChild(topRow);
      info.appendChild(preview);

      row.appendChild(avatar);
      row.appendChild(info);

      if (conv.unread) {
        const dot = document.createElement('div');
        dot.className = 'messages-unread-dot';
        row.appendChild(dot);
      }

      list.appendChild(row);
    });

    content.appendChild(list);
  }

  private formatTime(createdAt: string): string {
    const date = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('messages.just_now');
    if (diffMins < 60) return t('time.minutes_ago', { n: diffMins });
    if (diffHours < 24) return t('time.hours_ago', { n: diffHours });
    if (diffDays < 7) return t('time.days_ago', { n: diffDays });
    return date.toLocaleDateString();
  }

  public refresh(): void {
    this.fetchConversations();
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.element.remove();
  }
}

export function createMessagesPage(props: MessagesPageProps): MessagesPage {
  return new MessagesPage(props);
}
