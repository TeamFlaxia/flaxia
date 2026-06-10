import { t } from '../lib/i18n.js';

export interface Group {
  id: string;
  name: string;
  description: string;
  icon_key: string | null;
  created_by: string;
  created_at: string;
  my_role: string;
  member_count: number;
  last_message: {
    content: string;
    sender_id: string;
    created_at: string;
    is_mine: boolean;
  } | null;
  unread_count: number;
}

export interface GroupsPageProps {
  currentUser: { id: string; username: string; display_name?: string; avatar_key?: string } | null;
  onNavigateToGroup: (groupId: string) => void;
}

export class GroupsPage {
  private element: HTMLElement;
  private props: GroupsPageProps;
  private groups: Group[] = [];
  private loading = true;
  private searchResults: Array<{ id: string; username: string; display_name: string; avatar_key: string | null }> = [];
  private showCreateForm = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: GroupsPageProps) {
    this.props = props;
    this.element = this.createElement();
    this.fetchGroups();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'groups-page';

    // Header
    const header = document.createElement('div');
    header.className = 'groups-page-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'groups-page-back';
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
    title.textContent = t('groups.title');

    const newBtn = document.createElement('button');
    newBtn.className = 'groups-page-new-btn';
    newBtn.textContent = `+ ${t('groups.new')}`;
    newBtn.addEventListener('click', () => {
      this.toggleCreateForm();
    });

    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(newBtn);

    // Create group form (hidden by default)
    const createArea = document.createElement('div');
    createArea.id = 'groups-create-area';
    createArea.style.cssText = `
      display: none; padding: 12px 16px; border-bottom: 1px solid var(--border);
    `;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'groups-name-input';
    nameInput.placeholder = t('groups.name_placeholder');
    nameInput.style.cssText = `
      width: 100%; padding: 10px 14px; border: 1px solid var(--border);
      border-radius: 8px; background: var(--bg-secondary); color: var(--text-primary);
      font-size: 14px; font-family: inherit; outline: none; box-sizing: border-box;
      margin-bottom: 8px;
    `;

    const userSearch = document.createElement('input');
    userSearch.type = 'text';
    userSearch.id = 'groups-user-search';
    userSearch.placeholder = t('groups.search_users');
    userSearch.style.cssText = `
      width: 100%; padding: 10px 14px; border: 1px solid var(--border);
      border-radius: 8px; background: var(--bg-secondary); color: var(--text-primary);
      font-size: 14px; font-family: inherit; outline: none; box-sizing: border-box;
      margin-bottom: 8px;
    `;
    userSearch.addEventListener('input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.searchUsers(userSearch.value), 300);
    });

    const selectedUsers = document.createElement('div');
    selectedUsers.id = 'groups-selected-users';
    selectedUsers.style.cssText = `
      display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; min-height: 0;
    `;

    const searchResults = document.createElement('div');
    searchResults.id = 'groups-search-results';
    searchResults.style.cssText = `display: flex; flex-direction: column; gap: 1px; max-height: 200px; overflow-y: auto;`;

    const createSubmitBtn = document.createElement('button');
    createSubmitBtn.id = 'groups-create-submit';
    createSubmitBtn.textContent = t('groups.create');
    createSubmitBtn.style.cssText = `
      width: 100%; padding: 10px; background: var(--accent); color: #000;
      border: none; border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer; font-family: inherit;
    `;
    createSubmitBtn.addEventListener('click', () => this.createGroup());

    createArea.appendChild(nameInput);
    createArea.appendChild(userSearch);
    createArea.appendChild(selectedUsers);
    createArea.appendChild(searchResults);
    createArea.appendChild(createSubmitBtn);

    // Content area
    const content = document.createElement('div');
    content.id = 'groups-content';
    content.style.cssText = `display: flex; flex-direction: column;`;

    container.appendChild(header);
    container.appendChild(createArea);
    container.appendChild(content);

    return container;
  }

  private toggleCreateForm(): void {
    this.showCreateForm = !this.showCreateForm;
    const createArea = this.element.querySelector('#groups-create-area') as HTMLElement;
    if (this.showCreateForm) {
      createArea.style.display = '';
    } else {
      createArea.style.display = 'none';
      this.clearCreateForm();
    }
  }

  private clearCreateForm(): void {
    const nameInput = this.element.querySelector('#groups-name-input') as HTMLInputElement;
    const userSearch = this.element.querySelector('#groups-user-search') as HTMLInputElement;
    const searchResults = this.element.querySelector('#groups-search-results') as HTMLElement;
    if (nameInput) nameInput.value = '';
    if (userSearch) userSearch.value = '';
    if (searchResults) searchResults.innerHTML = '';
    this.searchResults = [];
    this.renderSelectedUsers();
  }

  private selectedMemberIds: string[] = [];
  private selectedMemberNames: Map<string, string> = new Map();

  private renderSelectedUsers(): void {
    const container = this.element.querySelector('#groups-selected-users') as HTMLElement;
    if (!container) return;
    container.innerHTML = '';
    this.selectedMemberIds.forEach((uid) => {
      const name = this.selectedMemberNames.get(uid) || uid;
      const chip = document.createElement('span');
      chip.style.cssText = `
        display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
        background: var(--accent); color: #000; border-radius: 12px;
        font-size: 12px; font-weight: 500;
      `;
      chip.textContent = name;
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.style.cssText = `
        background: none; border: none; cursor: pointer; font-size: 14px;
        color: #000; padding: 0 0 0 4px; line-height: 1;
      `;
      removeBtn.addEventListener('click', () => {
        this.selectedMemberIds = this.selectedMemberIds.filter((id) => id !== uid);
        this.selectedMemberNames.delete(uid);
        this.renderSelectedUsers();
      });
      chip.appendChild(removeBtn);
      container.appendChild(chip);
    });
  }

  private async searchUsers(query: string): Promise<void> {
    const searchResults = this.element.querySelector('#groups-search-results') as HTMLElement;
    if (!query || query.length < 1) {
      this.searchResults = [];
      if (searchResults) searchResults.innerHTML = '';
      return;
    }

    try {
      const res = await fetch(`/api/users/suggest?q=${encodeURIComponent(query)}`, { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as {
          users: Array<{ id: string; username: string; display_name: string; avatar_key: string | null }>;
        };
        this.searchResults = (data.users || []).filter(
          (u) => u.id !== this.props.currentUser?.id && !this.selectedMemberIds.includes(u.id),
        );
      }
    } catch {
      this.searchResults = [];
    }
    this.renderSearchResults();
  }

  private renderSearchResults(): void {
    const container = this.element.querySelector('#groups-search-results') as HTMLElement;
    if (!container) return;
    container.innerHTML = '';

    if (this.searchResults.length === 0) return;

    this.searchResults.forEach((user) => {
      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; align-items: center; gap: 12px; padding: 8px;
        cursor: pointer; border-radius: 8px; transition: background 0.15s ease;
      `;
      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--bg-secondary)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = '';
      });
      row.addEventListener('click', () => {
        if (!this.selectedMemberIds.includes(user.id)) {
          this.selectedMemberIds.push(user.id);
          this.selectedMemberNames.set(user.id, user.display_name || user.username);
          this.renderSelectedUsers();
        }
        const searchInput = this.element.querySelector('#groups-user-search') as HTMLInputElement;
        if (searchInput) searchInput.value = '';
        container.innerHTML = '';
      });

      const avatar = document.createElement('div');
      avatar.style.cssText = `
        width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
        background: var(--accent); display: flex; align-items: center; justify-content: center;
        color: #000; font-weight: 600; font-size: 14px; overflow: hidden;
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
      name.style.cssText = 'color: var(--text-primary); font-weight: 500; font-size: 14px;';
      name.textContent = user.display_name || user.username;
      const handle = document.createElement('div');
      handle.style.cssText = 'color: var(--text-muted); font-size: 12px;';
      handle.textContent = `@${user.username}`;
      info.appendChild(name);
      info.appendChild(handle);

      row.appendChild(avatar);
      row.appendChild(info);
      container.appendChild(row);
    });
  }

  private async createGroup(): Promise<void> {
    const nameInput = this.element.querySelector('#groups-name-input') as HTMLInputElement;
    const name = nameInput?.value?.trim();
    if (!name) return;

    const submitBtn = this.element.querySelector('#groups-create-submit') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.style.opacity = '0.5';

    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name,
          memberIds: this.selectedMemberIds,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { id: string };
        this.toggleCreateForm();
        this.props.onNavigateToGroup(data.id);
      } else {
        const err = (await res.json()) as { error?: string };
        console.error('Create group failed:', err.error);
      }
    } catch (e) {
      console.error('Failed to create group:', e);
    }

    submitBtn.disabled = false;
    submitBtn.style.opacity = '1';
  }

  private async fetchGroups(): Promise<void> {
    this.loading = true;
    try {
      const res = await fetch('/api/groups', { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { groups: Group[] };
        this.groups = data.groups || [];
      }
    } catch {
      this.groups = [];
    }
    this.loading = false;
    this.renderList();
  }

  private renderList(): void {
    const content = this.element.querySelector('#groups-content') as HTMLElement;
    if (!content) return;
    content.innerHTML = '';

    if (this.loading) {
      const loader = document.createElement('div');
      loader.style.cssText = 'text-align: center; padding: 48px 24px; color: var(--text-muted);';
      loader.textContent = t('common.loading');
      content.appendChild(loader);
      return;
    }

    if (this.groups.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align: center; padding: 48px 24px; color: var(--text-muted);';
      empty.textContent = t('groups.no_groups');
      content.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.style.cssText = 'display: flex; flex-direction: column;';

    this.groups.forEach((group) => {
      const row = document.createElement('div');
      row.className = 'groups-conv-row';
      row.style.background = group.unread_count > 0 ? 'var(--bg-secondary)' : 'var(--bg-primary)';
      row.addEventListener('mouseenter', () => {
        row.style.background = 'var(--bg-tertiary, #f0f0f0)';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = group.unread_count > 0 ? 'var(--bg-secondary)' : 'var(--bg-primary)';
      });
      row.addEventListener('click', () => this.props.onNavigateToGroup(group.id));

      const avatar = document.createElement('div');
      avatar.className = 'groups-conv-avatar';
      if (group.icon_key) {
        avatar.style.backgroundImage = `url(/api/images/${group.icon_key})`;
        avatar.style.backgroundSize = 'cover';
        avatar.textContent = '';
      } else {
        avatar.textContent = group.name.charAt(0).toUpperCase();
      }

      const info = document.createElement('div');
      info.className = 'groups-conv-info';

      const topRow = document.createElement('div');
      topRow.className = 'groups-conv-top';

      const name = document.createElement('div');
      name.className = `groups-conv-name ${group.unread_count > 0 ? 'unread' : 'read'}`;
      name.textContent = group.name;

      const meta = document.createElement('div');
      meta.className = 'groups-conv-meta';
      meta.textContent = `${group.member_count} members`;

      const time = document.createElement('div');
      time.className = 'groups-conv-time';
      if (group.last_message) {
        time.textContent = this.formatTime(group.last_message.created_at);
      }

      topRow.appendChild(name);
      topRow.appendChild(time);

      const preview = document.createElement('div');
      preview.className = `groups-conv-preview ${group.unread_count > 0 ? 'unread' : 'read'}`;
      if (group.last_message) {
        preview.textContent = group.last_message.content;
      }

      info.appendChild(topRow);
      info.appendChild(meta);
      info.appendChild(preview);

      row.appendChild(avatar);
      row.appendChild(info);

      if (group.unread_count > 0) {
        const badge = document.createElement('div');
        badge.className = 'groups-unread-badge';
        badge.textContent = String(group.unread_count);
        row.appendChild(badge);
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
    this.fetchGroups();
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.element.remove();
  }
}

export function createGroupsPage(props: GroupsPageProps): GroupsPage {
  return new GroupsPage(props);
}
