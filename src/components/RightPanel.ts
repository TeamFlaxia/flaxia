import { formatCount, formatPercentage, relativeBarPercent } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { type IconName, icon } from '../lib/icons.js';
import { nativeApiHref } from '../lib/native-api.js';
import { commandShortcutLabel } from '../lib/shortcut-label.js';
import { openShortcutSheet } from '../lib/shortcut-sheet.js';

interface TrendingTag {
  tag: string;
  count: number;
  percentage: number;
}

interface PopularGame {
  id: string;
  postId: string;
  title: string;
  username: string;
  thumbnailKey?: string;
  freshCount: number;
  impressions: number;
}

/**
 * Right column: search, hashtag ranking, popular games and a help card.
 * Presentation lives in shell.css and follows the legacy skin.
 */
export class RightPanel {
  private element: HTMLElement;
  private trendingTags: TrendingTag[] = [];
  private gamesSection: HTMLElement | null = null;

  constructor() {
    this.element = this.createElement();
    this.setupEventListeners();
    this.loadTrendingTags();
    this.loadPopularGames();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('aside');
    container.className = 'right-panel';
    container.setAttribute('aria-label', 'Discover');

    container.appendChild(this.createSearchSection());
    container.appendChild(this.createTrendingSection());
    this.gamesSection = this.createGamesSection();
    container.appendChild(this.gamesSection);
    container.appendChild(this.createHelpSection());

    return container;
  }

  /** Card head: optional icon + title plus an optional "see all" link. */
  private createCardHead(
    titleText: string,
    options: { iconName?: IconName; moreHref?: string; moreLabel?: string } = {},
  ): HTMLElement {
    const head = document.createElement('div');
    head.className = 'right-card-head';

    const title = document.createElement('h3');
    title.className = 'right-card-title';
    if (options.iconName) {
      const titleIcon = icon(options.iconName, { width: '14', height: '14' });
      titleIcon.classList.add('right-card-title-icon');
      title.appendChild(titleIcon);
    }
    const text = document.createElement('span');
    text.textContent = titleText;
    title.appendChild(text);
    head.appendChild(title);

    if (options.moreHref) {
      const href = options.moreHref;
      const more = document.createElement('a');
      more.className = 'right-card-more';
      more.href = href;
      more.textContent = options.moreLabel ?? t('right_panel.see_all');
      more.addEventListener('click', (event) => {
        event.preventDefault();
        this.navigate(href);
      });
      head.appendChild(more);
    }

    return head;
  }

  private createCard(extraClass = ''): { section: HTMLElement; body: HTMLElement } {
    const section = document.createElement('section');
    section.className = `right-card ${extraClass}`.trim();

    const body = document.createElement('div');
    body.className = 'right-card-body';

    return { section, body };
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

    // The shortcut chip advertises the real ⌘K / Ctrl-K binding.
    const kbd = document.createElement('kbd');
    kbd.className = 'search-kbd';
    kbd.textContent = commandShortcutLabel();

    searchBox.appendChild(input);
    searchBox.appendChild(iconWrap);
    searchBox.appendChild(kbd);
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
    const { section, body } = this.createCard('trending-section');
    body.classList.add('trending-list');

    section.appendChild(this.createCardHead(t('right_panel.trending'), { iconName: 'hash', moreHref: '/explore' }));
    section.appendChild(body);

    const loading = this.createStatusRow(t('common.loading'));
    loading.classList.add('trending-loading');
    body.appendChild(loading);

    return section;
  }

  private createGamesSection(): HTMLElement {
    const { section, body } = this.createCard('games-section');
    body.classList.add('games-list');
    section.appendChild(this.createCardHead(t('right_panel.popular_games'), { iconName: 'game', moreHref: '/arcade' }));
    section.appendChild(body);
    body.appendChild(this.createStatusRow(t('common.loading')));
    return section;
  }

  private createHelpSection(): HTMLElement {
    const { section, body } = this.createCard('help-section');
    section.appendChild(this.createCardHead(t('right_panel.help_title'), { iconName: 'help' }));
    section.appendChild(body);
    body.classList.add('help-list');

    const rows: Array<{ iconName: IconName; text: string; run: () => void }> = [
      {
        iconName: 'game',
        text: t('right_panel.help_shortcuts'),
        run: () => openShortcutSheet(),
      },
      {
        iconName: 'guide',
        text: t('right_panel.help_guide'),
        run: () => this.navigate('/docs'),
      },
      {
        iconName: 'users',
        text: t('right_panel.help_guidelines'),
        run: () => this.navigate('/docs/how2join'),
      },
    ];

    for (const row of rows) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'help-item';
      item.appendChild(icon(row.iconName, { width: '16', height: '16' }));

      const text = document.createElement('span');
      text.className = 'help-item-text';
      text.textContent = row.text;
      item.appendChild(text);

      item.appendChild(icon('chevron-right', { width: '15', height: '15' }));
      item.addEventListener('click', row.run);
      body.appendChild(item);
    }

    return section;
  }

  private navigate(href: string): void {
    if (href === '/explore') {
      window.history.pushState({}, '', href);
      window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore' } }));
      return;
    }
    window.history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
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

      const data = (await response.json()) as { tags: TrendingTag[] };
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

    const maxCount = Math.max(...this.trendingTags.map(({ count }) => count), 1);

    this.trendingTags.forEach(({ tag, count, percentage }, index) => {
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
      // Every row is a hashtag: the title says what the list is, so no row
      // gets a special "no #" treatment.
      hashtag.textContent = `#${tag}`;

      // The bar compares tags with each other; the text keeps the true share
      // of the recent-post sample so the graph cannot overstate a tag.
      const bar = document.createElement('div');
      bar.className = 'trending-bar';
      bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.className = 'trending-bar-fill';
      fill.style.width = `${relativeBarPercent(count, maxCount)}%`;
      bar.appendChild(fill);

      const countEl = document.createElement('div');
      countEl.className = 'trending-count';
      countEl.textContent = Number.isFinite(percentage)
        ? `${t('right_panel.trending_percent', { percentage: formatPercentage(percentage) })} · ${t('right_panel.trending_count', { count })}`
        : t('right_panel.trending_count', { count });

      content.appendChild(hashtag);
      content.appendChild(bar);
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

  private async loadPopularGames(): Promise<void> {
    const list = this.gamesSection?.querySelector('.games-list');
    if (!list) return;

    try {
      const response = await fetch('/api/games?trending=true&limit=3');
      if (!response.ok) throw new Error('Failed to load games');

      const data = (await response.json()) as { games?: PopularGame[] };
      const games = (data.games ?? []).slice(0, 3);

      if (games.length === 0) {
        this.gamesSection?.remove();
        this.gamesSection = null;
        return;
      }

      list.innerHTML = '';
      for (const game of games) {
        list.appendChild(this.createGameRow(game));
      }
    } catch (error) {
      console.error('Failed to load popular games:', error);
      this.gamesSection?.remove();
      this.gamesSection = null;
    }
  }

  private createGameRow(game: PopularGame): HTMLElement {
    const row = document.createElement('a');
    row.className = 'game-item';
    row.href = `/arcade/${game.postId}`;

    const thumb = document.createElement('div');
    thumb.className = 'game-thumb';
    if (game.thumbnailKey) {
      const img = document.createElement('img');
      img.src = nativeApiHref(`/api/thumbnail/${game.postId}`);
      img.alt = '';
      img.loading = 'lazy';
      img.width = 48;
      img.height = 48;
      thumb.appendChild(img);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'game-thumb-fallback';
      fallback.textContent = '🎮';
      thumb.appendChild(fallback);
    }

    const info = document.createElement('div');
    info.className = 'game-info';

    const title = document.createElement('div');
    title.className = 'game-title';
    title.textContent = game.title;
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'game-meta';

    const plays = document.createElement('span');
    plays.appendChild(icon('impressions', { width: '13', height: '13' }));
    plays.appendChild(document.createTextNode(formatCount(game.impressions ?? 0)));

    const likes = document.createElement('span');
    likes.appendChild(icon('fresh', { width: '13', height: '13' }));
    likes.appendChild(document.createTextNode(formatCount(game.freshCount ?? 0)));

    meta.appendChild(plays);
    meta.appendChild(likes);
    info.appendChild(meta);

    row.appendChild(thumb);
    row.appendChild(info);

    row.addEventListener('click', (event) => {
      event.preventDefault();
      window.history.pushState({}, '', `/arcade/${game.postId}`);
      window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'arcade', postId: game.postId } }));
    });

    return row;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.element.remove();
  }
}

// Factory function for easier usage
export function createRightPanel(): RightPanel {
  return new RightPanel();
}
