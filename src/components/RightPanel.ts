import { attachPlusBadge } from '../lib/avatar.js';
import { getLocale, t } from '../lib/i18n.js';
import { icon } from '../lib/icons.js';
import { applyNameColor } from '../lib/name-color.js';
import { nativeApiHref } from '../lib/native-api.js';
import { commandShortcutLabel } from '../lib/shortcut-label.js';

export interface RightPanelProps {
  onSearch?: (query: string) => void;
  onFollowUser?: (userId: string) => void;
}

export interface UserSuggestion {
  id: string;
  username: string;
  display_name: string;
  avatar_key?: string;
  badge_type?: string | null;
  name_color?: string | null;
}

const label = (ja: string, en: string): string => (getLocale().startsWith('ja') ? ja : en);

/**
 * v5 "quiet craft" right column: search, trending ranks, who-to-follow and an
 * Obsidian-style shortcuts card. Presentation lives in shell.css.
 */
export class RightPanel {
  private element: HTMLElement;
  private trendingTags: Array<{ tag: string; count: number; percentage: number }> = [];
  private userSuggestions: UserSuggestion[] = [];

  constructor(props: RightPanelProps = {}) {
    this.element = this.createElement();
    this.setupEventListeners();
    this.loadTrendingTags();
    this.loadUserSuggestions();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('aside');
    container.className = 'right-panel';
    container.setAttribute('aria-label', 'Discover');

    container.appendChild(this.createSearchSection());
    container.appendChild(this.createTrendingSection());
    container.appendChild(this.createFollowSection());
    container.appendChild(this.createShortcutsSection());

    return container;
  }

  private createCard(titleText: string, extraClass = ''): { section: HTMLElement; list: HTMLElement } {
    const section = document.createElement('section');
    section.className = `right-card ${extraClass}`.trim();

    const title = document.createElement('h3');
    title.className = 'right-card-title fx-label';
    title.textContent = titleText;
    section.appendChild(title);

    const list = document.createElement('div');
    list.className = 'right-card-body';
    section.appendChild(list);

    return { section, list };
  }

  private createSearchSection(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'right-card search-section';

    const searchBox = document.createElement('div');
    searchBox.className = 'search-box';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-input';
    input.placeholder = t('right_panel.search_placeholder');
    input.setAttribute('aria-label', t('right_panel.search_placeholder'));

    const iconWrap = document.createElement('span');
    iconWrap.className = 'search-icon';
    iconWrap.appendChild(icon('search', { width: '15', height: '15' }));

    searchBox.appendChild(input);
    searchBox.appendChild(iconWrap);
    section.appendChild(searchBox);

    return section;
  }

  private createStatusRow(text: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'right-card-status';
    row.textContent = text;
    return row;
  }

  private createTrendingSection(): HTMLElement {
    const { section, list } = this.createCard('', 'trending-section');
    // The top tag is the headline of this card; a "Trending" caption above it
    // only labels what the reader already sees.
    const title = section.querySelector('.right-card-title') as HTMLElement;
    title.remove();

    list.classList.add('trending-list');

    const loading = this.createStatusRow(t('common.loading'));
    loading.classList.add('trending-loading');
    list.appendChild(loading);

    return section;
  }

  private createFollowSection(): HTMLElement {
    const { section, list } = this.createCard(t('right_panel.who_to_follow'), 'follow-section');
    section.style.display = 'none'; // shown when suggestions load
    list.classList.add('follow-list');

    const loading = this.createStatusRow(t('common.loading'));
    loading.classList.add('follow-loading');
    list.appendChild(loading);

    return section;
  }

  /** Obsidian-like cheat sheet: ⌘K / N / T rows. */
  private createShortcutsSection(): HTMLElement {
    const { section, list } = this.createCard(label('ショートカット', 'Shortcuts'), 'shortcuts-section');

    const rows: Array<[string, string]> = [
      [commandShortcutLabel(), label('検索・コマンド', 'Search or command')],
      ['N', label('投稿', 'New post')],
      ['T', label('テーマ切替', 'Toggle theme')],
    ];

    for (const [keys, text] of rows) {
      const row = document.createElement('div');
      row.className = 'shortcut-row';

      const desc = document.createElement('span');
      desc.className = 'shortcut-label';
      desc.textContent = text;

      const kbd = document.createElement('kbd');
      kbd.className = 'shortcut-kbd';
      kbd.textContent = keys;

      row.appendChild(desc);
      row.appendChild(kbd);
      list.appendChild(row);
    }

    return section;
  }

  private setupEventListeners(): void {
    const searchInput = this.element.querySelector('.search-input') as HTMLInputElement | null;
    if (!searchInput) return;

    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const query = searchInput.value.trim();
        if (query) {
          this.performSearch(query);
        }
      }
    });
  }

  private performSearch(query: string): void {
    window.history.pushState({}, '', `/search?q=${encodeURIComponent(query)}&type=posts`);
    window.dispatchEvent(
      new CustomEvent('spaNavigate', {
        detail: { view: 'search', searchQuery: query, searchType: 'posts' },
      }),
    );
  }

  private async loadTrendingTags(): Promise<void> {
    try {
      const response = await fetch('/api/tags/trending');
      if (!response.ok) {
        throw new Error('Failed to load trending tags');
      }

      const data = (await response.json()) as { tags: Array<{ tag: string; count: number; percentage: number }> };
      this.trendingTags = data.tags || [];
      this.renderTrendingTags();
    } catch (error) {
      console.error('Failed to load trending tags:', error);
    }
  }

  private renderTrendingTags(): void {
    const trendingList = this.element.querySelector('.trending-list');
    if (!trendingList) return;

    trendingList.innerHTML = '';

    if (this.trendingTags.length === 0) {
      trendingList.appendChild(this.createStatusRow(t('right_panel.no_trending')));
      return;
    }

    this.trendingTags.forEach(({ tag, count }, index) => {
      // A row navigates, so it is a link, not a div with a role bolted on.
      const item = document.createElement('a');
      item.className = 'trending-item';
      item.href = `/explore?tag=${encodeURIComponent(tag)}`;
      item.dataset.count = String(count);

      const rank = document.createElement('span');
      rank.className = 'trending-rank';
      rank.textContent = String(index + 1);

      const content = document.createElement('div');
      content.className = 'trending-content';

      const hashtag = document.createElement('div');
      hashtag.className = 'trending-hashtag';
      // Rank 1 carries the weight; the rest are a readable list under it.
      hashtag.textContent = index === 0 ? tag : `#${tag}`;

      const countEl = document.createElement('div');
      countEl.className = 'trending-count';
      countEl.textContent = t('right_panel.trending_count', { count });

      content.appendChild(hashtag);
      content.appendChild(countEl);
      item.appendChild(rank);
      item.appendChild(content);

      item.addEventListener('click', (e) => {
        e.preventDefault();
        window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(tag)}`);
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore', tag } }));
      });

      trendingList.appendChild(item);
    });
  }

  private async loadUserSuggestions(): Promise<void> {
    try {
      const response = await fetch('/api/users/suggestions');
      if (!response.ok) {
        throw new Error('Failed to load user suggestions');
      }

      const data = (await response.json()) as { users: UserSuggestion[] };
      this.userSuggestions = data.users || [];
      this.renderUserSuggestions();
    } catch (error) {
      console.error('Failed to load user suggestions:', error);
    }
  }

  private renderUserSuggestions(): void {
    const followSection = this.element.querySelector('.follow-section') as HTMLElement | null;
    const followList = this.element.querySelector('.follow-list');

    if (!followSection || !followList) return;

    if (this.userSuggestions.length === 0) {
      followSection.style.display = 'none';
      return;
    }

    followSection.style.display = 'block';
    followList.innerHTML = '';

    this.userSuggestions.forEach((user) => {
      const item = document.createElement('div');
      item.className = 'follow-item';
      item.dataset.userId = user.id;

      const avatar = document.createElement('div');
      avatar.className = 'follow-avatar';
      if (user.avatar_key) {
        avatar.style.backgroundImage = `url('${nativeApiHref(`/api/images/${user.avatar_key}`)}')`;
      }
      if (!user.avatar_key) {
        avatar.textContent = user.display_name.charAt(0).toUpperCase();
      }
      attachPlusBadge(avatar, user.badge_type);

      const info = document.createElement('div');
      info.className = 'follow-info';

      const name = document.createElement('div');
      name.className = 'follow-name';
      name.textContent = user.display_name;
      applyNameColor(name, user.name_color, user.badge_type);
      name.addEventListener('click', () => {
        window.location.href = `/profile/${user.username}`;
      });

      const handle = document.createElement('div');
      handle.className = 'follow-handle';
      handle.textContent = `@${user.username}`;

      info.appendChild(name);
      info.appendChild(handle);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'follow-button';
      button.textContent = t('right_panel.follow');

      button.addEventListener('click', async (e) => {
        e.preventDefault();
        await this.followUser(user.id, item);
      });

      item.appendChild(avatar);
      item.appendChild(info);
      item.appendChild(button);

      followList.appendChild(item);
    });
  }

  private async followUser(userId: string, itemElement: HTMLElement): Promise<void> {
    try {
      const response = await fetch(`/api/follows/${userId}`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to follow user');
      }

      this.userSuggestions = this.userSuggestions.filter((user) => user.id !== userId);

      itemElement.style.opacity = '0';
      itemElement.style.transform = 'translateX(12px)';

      setTimeout(() => {
        itemElement.remove();

        if (this.userSuggestions.length === 0) {
          const followSection = this.element.querySelector('.follow-section') as HTMLElement | null;
          if (followSection) {
            followSection.style.display = 'none';
          }
        }
      }, 200);
    } catch (error) {
      console.error('Failed to follow user:', error);
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.element.remove();
  }
}

// Factory function for easier usage
export function createRightPanel(props: RightPanelProps = {}): RightPanel {
  return new RightPanel(props);
}
