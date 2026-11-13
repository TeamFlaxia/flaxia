import { attachPlusBadge } from '../lib/avatar.js';
import { createFabButton } from '../lib/fab-button.js';
import { formatCount, formatPercentage, relativeBarPercent } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { createInfiniteScroll } from '../lib/infinite-scroll.js';
import { createSkeletonCards } from '../lib/loading-ui.js';
import { applyNameColor } from '../lib/name-color.js';
import { nativeApiHref } from '../lib/native-api.js';
import { createPageHeader } from '../lib/page-header.js';
import { openPostModal } from '../lib/post-modal.js';
import { createPostUpdatedHandler } from '../lib/post-update.js';
import { updateMetaTags } from '../lib/seo-meta.js';
import { pushSpaHistory } from '../lib/spa-history.js';
import { Post } from '../types/post.js';
import { createPostCard } from './PostCard.js';

export interface ExplorePageProps {
  tag?: string;
  sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
}

interface ArcadeGame {
  id: string;
  postId: string;
  title: string;
  username: string;
  displayName?: string;
  avatarKey?: string;
  type: string;
  swfKey?: string;
  payloadKey?: string;
  thumbnailKey?: string;
  freshCount: number;
  replyCount: number;
  impressions: number;
  isFreshed: boolean;
  createdAt: string;
}
export class ExplorePage {
  private element: HTMLElement;
  private props: ExplorePageProps;
  private posts: Post[] = [];
  private arcadePosts: ArcadeGame[] = [];
  private userSuggestions: Array<{
    id: string;
    username: string;
    display_name?: string;
    avatar_key?: string;
    badge_type?: string | null;
    name_color?: string | null;
    bio?: string;
  }> = [];
  private cursor?: string;
  private loading = false;
  private hasMore = true;
  private infiniteScroll: ReturnType<typeof createInfiniteScroll>;
  private activeFilter: 'posts' | 'arcade' | 'users' = 'posts';
  private searchFilter: 'posts' | 'users' | 'arcade' = 'posts';
  private fabButton: HTMLElement | null = null;
  private tagCountEl: HTMLElement | null = null;
  private totalTagCount: number = 0;
  private suggestAbortController: AbortController | null = null;
  private static readonly SEARCH_HISTORY_KEY = 'flaxia_search_history';
  private static readonly MAX_HISTORY = 10;
  private postCards: Map<string, ReturnType<typeof createPostCard>> = new Map();
  private postUpdatedHandler?: (e: Event) => void;

  constructor(props: ExplorePageProps) {
    this.props = props;
    this.infiniteScroll = createInfiniteScroll({
      onLoadMore: () => this.loadMorePosts(),
      canLoadMore: () => !this.loading && this.hasMore,
    });
    this.element = this.createElement();
    this.setupEventListeners();
    this.setupPostUpdatedListener();
    this.loadContent();

    if (props.tag) {
      updateMetaTags({
        title: `Flaxia - #${props.tag}`,
        description: `Explore posts tagged #${props.tag} on Flaxia`,
        url: `${window.location.origin}/explore?tag=${encodeURIComponent(props.tag)}`,
      });
    }
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'explore-page';

    // Add search section
    const searchSection = this.createSearchSection();
    container.appendChild(searchSection);

    // 'posts' button is set as active by default in createSearchSection

    if (this.props.tag) {
      container.appendChild(
        createPageHeader({
          title: `# ${this.props.tag}`,
          subtitle: t('explore.tag_count', { count: formatCount(0) }),
          subtitleRef: (el) => {
            this.tagCountEl = el;
          },
          onBack: () => window.history.back(),
        }),
      );

      const postsContainer = document.createElement('div');
      postsContainer.className = 'explore-posts';
      container.appendChild(postsContainer);
    } else {
      const contentContainer = document.createElement('div');
      contentContainer.className = 'explore-content';

      const trendingTagsContainer = document.createElement('div');
      trendingTagsContainer.className = 'explore-trending-tags';
      contentContainer.appendChild(trendingTagsContainer);

      const postsContainer = document.createElement('div');
      postsContainer.className = 'explore-posts';
      contentContainer.appendChild(postsContainer);

      container.appendChild(contentContainer);
    }

    // Add loading container
    const loadingContainer = document.createElement('div');
    loadingContainer.className = 'explore-loading';
    loadingContainer.style.cssText = 'display: none;';
    container.appendChild(loadingContainer);

    container.appendChild(this.infiniteScroll.sentinel);
    this.infiniteScroll.sentinel.style.marginTop = '1rem';

    if (this.props.currentUser) {
      this.fabButton = createFabButton(() => {
        openPostModal({
          currentUser: this.props.currentUser,
          onPostCreated: (post) => this.handleNewPost(post as unknown as Post),
        });
      }, true);
      container.appendChild(this.fabButton);
    }

    return container;
  }

  private createSearchSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'explore-search-section';

    const searchBox = document.createElement('div');
    searchBox.className = 'search-box';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-input';
    input.placeholder = t('explore.search_placeholder');

    const icon = document.createElement('span');
    icon.className = 'search-icon';
    icon.setAttribute('aria-hidden', 'true');

    searchBox.appendChild(input);
    searchBox.appendChild(icon);

    const suggestDropdown = document.createElement('div');
    suggestDropdown.className = 'tag-suggest-dropdown';
    suggestDropdown.style.cssText = `
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 100;
      max-height: 300px;
      overflow-y: auto;
      margin-top: 4px;
    `;
    searchBox.appendChild(suggestDropdown);

    section.appendChild(searchBox);

    // Filter bar
    const filterBar = document.createElement('div');
    filterBar.className = 'explore-filter-bar';

    const filters: { key: 'posts' | 'arcade' | 'users'; label: string }[] = [
      { key: 'posts', label: t('explore.filter_posts') },
      { key: 'arcade', label: t('explore.filter_arcade') },
      { key: 'users', label: t('explore.filter_users') },
    ];

    for (const f of filters) {
      const btn = document.createElement('button');
      btn.className = 'explore-filter-btn';
      btn.dataset.filter = f.key;
      btn.textContent = f.label;
      const isActive = f.key === 'posts';
      if (isActive) btn.classList.add('is-active');
      btn.onclick = () => this.switchFilter(f.key);
      filterBar.appendChild(btn);
    }

    section.appendChild(filterBar);

    return section;
  }

  private setupEventListeners(): void {
    const searchInput = this.element.querySelector('.search-input') as HTMLInputElement;
    const suggestDropdown = this.element.querySelector('.tag-suggest-dropdown') as HTMLElement;

    if (searchInput && suggestDropdown) {
      const fetchSuggestions = async (prefix: string, type: 'tag' | 'user') => {
        if (this.suggestAbortController) this.suggestAbortController.abort();
        const controller = new AbortController();
        this.suggestAbortController = controller;
        try {
          const url =
            type === 'tag'
              ? `/api/tags/suggest?q=${encodeURIComponent(prefix)}`
              : `/api/users/suggest?q=${encodeURIComponent(prefix)}`;
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) return;
          if (type === 'tag') {
            const data = (await res.json()) as { tags: { tag: string; count: number }[] };
            this.renderSuggestions(
              suggestDropdown,
              (data.tags || []).map((t) => ({ type: 'tag' as const, label: t.tag, count: t.count })),
            );
          } else {
            const data = (await res.json()) as {
              users: { username: string; display_name: string; avatar_key: string; badge_type?: string | null }[];
            };
            this.renderSuggestions(
              suggestDropdown,
              (data.users || []).map((u) => ({
                type: 'user' as const,
                label: u.username,
                display: u.display_name,
                avatar: u.avatar_key,
                badge: u.badge_type ?? null,
              })),
            );
          }
        } catch (err: unknown) {
          if ((err as { name?: string })?.name !== 'AbortError') console.error('Suggest error:', err);
        }
      };

      searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const query = searchInput.value.trim();
          this.suggestAbortController?.abort();
          suggestDropdown.style.display = 'none';

          if (query.startsWith('#')) {
            const afterHash = query.slice(1).trim();
            const spaceIdx = afterHash.indexOf(' ');
            if (spaceIdx === -1 && afterHash) {
              window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(afterHash)}`);
              window.location.reload();
              return;
            }
          }

          if (query.startsWith('@')) {
            this.performSearch(query);
            return;
          }

          this.performSearch(query);
        }
      });

      let suggestTimer: ReturnType<typeof setTimeout> | null = null;

      searchInput.addEventListener('input', () => {
        const val = searchInput.value;

        if (this.suggestAbortController) this.suggestAbortController.abort();
        if (suggestTimer) clearTimeout(suggestTimer);

        if (val.startsWith('#')) {
          const prefix = val.slice(1);
          if (!prefix) {
            suggestDropdown.style.display = 'none';
            return;
          }
          suggestTimer = setTimeout(() => fetchSuggestions(prefix, 'tag'), 200);
          return;
        }

        if (val.startsWith('@')) {
          const prefix = val.slice(1);
          if (!prefix) {
            suggestDropdown.style.display = 'none';
            return;
          }
          suggestTimer = setTimeout(() => fetchSuggestions(prefix, 'user'), 200);
          return;
        }

        if (val.length === 0) {
          this.renderSearchHistory(suggestDropdown);
          return;
        }

        suggestDropdown.style.display = 'none';
      });

      searchInput.addEventListener('focus', () => {
        if (!searchInput.value) {
          this.renderSearchHistory(suggestDropdown);
        }
      });

      searchInput.addEventListener('blur', () => {
        setTimeout(() => {
          suggestDropdown.style.display = 'none';
        }, 200);
      });

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          suggestDropdown.style.display = 'none';
          searchInput.blur();
        }
      });
    }
  }

  private renderSuggestions(
    dropdown: HTMLElement,
    items: {
      type: 'tag' | 'user';
      label: string;
      count?: number;
      display?: string;
      avatar?: string;
      badge?: string | null;
    }[],
  ): void {
    dropdown.innerHTML = '';

    if (items.length === 0) {
      dropdown.style.display = 'none';
      return;
    }

    dropdown.style.display = 'block';

    for (const it of items) {
      const item = document.createElement('div');
      item.style.cssText = `
        padding: 0.6rem 0.75rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        transition: background 0.15s;
      `;
      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none';
      });

      if (it.type === 'tag') {
        const tagName = document.createElement('span');
        tagName.textContent = `# ${it.label}`;
        tagName.style.cssText = 'font-weight: 600; color: var(--accent-text); font-size: 0.875rem;';

        const count = document.createElement('span');
        count.textContent = formatCount(it.count || 0);
        count.style.cssText = 'margin-left: auto; color: var(--text-muted); font-size: 0.75rem;';

        item.appendChild(tagName);
        item.appendChild(count);

        item.addEventListener('click', () => {
          dropdown.style.display = 'none';
          window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(it.label)}`);
          window.location.reload();
        });
      } else {
        const avatar = document.createElement('div');
        avatar.style.cssText = `
          width: 28px; height: 28px; border-radius: 50%;
          background: var(--accent); color: var(--on-accent);
          display: flex; align-items: center; justify-content: center;
          font-weight: bold; font-size: 0.7rem; flex-shrink: 0;
        `;
        avatar.textContent = (it.display || it.label)[0].toUpperCase();
        attachPlusBadge(avatar, it.badge);

        const info = document.createElement('div');
        info.style.cssText = 'display: flex; flex-direction: column;';

        const name = document.createElement('span');
        name.textContent = `@${it.label}`;
        name.style.cssText = 'font-weight: 600; color: var(--text-primary); font-size: 0.85rem;';

        const display = document.createElement('span');
        display.textContent = it.display || '';
        display.style.cssText = 'font-size: 0.75rem; color: var(--text-muted);';

        info.appendChild(name);
        info.appendChild(display);
        item.appendChild(avatar);
        item.appendChild(info);

        item.addEventListener('click', () => {
          dropdown.style.display = 'none';
          window.history.pushState({}, '', `/profile/${encodeURIComponent(it.label)}`);
          window.dispatchEvent(
            new CustomEvent('spaNavigate', {
              detail: { view: 'profile', username: it.label },
            }),
          );
        });
      }

      dropdown.appendChild(item);
    }
  }

  private async loadContent(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.updateLoadingState(true);

    try {
      if (this.props.tag) {
        await this.loadTagPosts();
      } else {
        switch (this.activeFilter) {
          case 'posts':
            await this.loadTrendingContent();
            break;
          case 'arcade':
            await this.loadArcadeContent();
            break;
          case 'users':
            await this.loadUsersContent();
            break;
        }
      }
    } catch (error) {
      console.error('Failed to load explore content:', error);
    } finally {
      this.loading = false;
      this.updateLoadingState(false);
    }
  }

  private async loadMorePosts(): Promise<void> {
    if (this.loading || !this.hasMore) return;

    this.loading = true;
    this.updateLoadingState(true);

    try {
      let url = '';
      if (this.props.tag) {
        url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag)}&limit=10`;
      } else if (this.activeFilter === 'arcade') {
        url = `/api/games?limit=10`;
      } else {
        url = `/api/posts/trending?limit=10`;
      }

      if (this.cursor) {
        if (this.props.tag) {
          url += `&cursor=${encodeURIComponent(this.cursor)}`;
        } else if (this.activeFilter === 'arcade') {
          url += `&cursor=${encodeURIComponent(this.cursor)}`;
        } else if (this.cursor.includes(',')) {
          url += `&cursor=${encodeURIComponent(this.cursor)}`;
        } else {
          this.cursor = undefined;
        }
      }

      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to load more posts');

      if (this.activeFilter === 'arcade') {
        const data = (await response.json()) as { games: ArcadeGame[]; hasMore: boolean; cursor?: string | null };
        const newPosts = data.games || [];
        if (newPosts.length > 0) {
          this.arcadePosts.push(...newPosts);
          this.cursor = data.cursor ?? undefined;
          this.hasMore = data.hasMore;
          this.renderArcadePosts();
        } else {
          this.hasMore = false;
          this.showEndOfPosts();
        }
      } else {
        const data = (await response.json()) as { posts: Post[] };
        const newPosts = data.posts || [];

        if (newPosts.length > 0) {
          this.posts.push(...newPosts);
          if (!this.props.tag) {
            const lastPost = newPosts[newPosts.length - 1] as Post & { score: number };
            this.cursor = `${lastPost.score},${lastPost.created_at}`;
          } else {
            this.cursor = newPosts[newPosts.length - 1].created_at;
          }
          this.hasMore = newPosts.length === 10;
          this.renderPosts();
        } else {
          this.hasMore = false;
          this.showEndOfPosts();
        }
      }
    } catch (error) {
      console.error('Failed to load more posts:', error);
      this.showLoadError();
    } finally {
      this.loading = false;
      this.updateLoadingState(false);
    }
  }

  private async loadTagPosts(): Promise<void> {
    let url = `/api/posts?hashtag=${encodeURIComponent(this.props.tag!)}&limit=10`;
    if (this.cursor) {
      url += `&cursor=${encodeURIComponent(this.cursor)}`;
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to load tag posts');
    const data = (await response.json()) as { posts: Post[]; count?: number };
    if (data.count !== undefined) {
      this.totalTagCount = data.count;
    }
    this.handleNewPosts(data.posts);
  }

  private async loadTrendingContent(): Promise<void> {
    // Load both trending tags and trending posts
    const [tagsRes, postsRes] = await Promise.all([fetch('/api/tags/trending'), fetch('/api/posts/trending?limit=10')]);

    if (tagsRes.ok) {
      const tagsData = (await tagsRes.json()) as {
        tags: Array<{ tag: string; count: number; percentage?: number }>;
      };
      this.renderTrendingTags(tagsData.tags || []);
    }

    if (postsRes.ok) {
      const postsData = (await postsRes.json()) as { posts: Post[] };
      this.handleNewPosts(postsData.posts || []);
    }
  }

  private async loadArcadeContent(): Promise<void> {
    const res = await fetch('/api/games?limit=10');
    if (res.ok) {
      const data = (await res.json()) as { games: ArcadeGame[]; hasMore: boolean; cursor?: string | null };
      this.arcadePosts = data.games || [];
      this.cursor = data.cursor ?? undefined;
      this.hasMore = data.hasMore;
      this.renderArcadePosts();
    }
  }

  private async loadUsersContent(): Promise<void> {
    const res = await fetch('/api/users/suggestions');
    if (res.ok) {
      const data = (await res.json()) as {
        users: Array<{
          id: string;
          username: string;
          display_name?: string;
          avatar_key?: string;
          badge_type?: string | null;
          bio?: string;
        }>;
      };
      this.userSuggestions = data.users || [];
      this.hasMore = false;
      this.renderUserSuggestions();
    }
  }

  private handleNewPosts(newPosts: Post[]): void {
    if (newPosts.length > 0) {
      this.posts.push(...newPosts);
      this.cursor = newPosts[newPosts.length - 1].created_at;
      this.hasMore = newPosts.length === 10;
      this.renderPosts();
    } else {
      this.hasMore = false;
      if (this.posts.length > 0) this.showEndOfPosts();
    }
    this.updateTagCount();
  }

  private performSearch(query: string): void {
    this.saveSearchHistory(query);
    window.history.pushState({}, '', `/search?q=${encodeURIComponent(query)}&type=${this.searchFilter}`);
    window.dispatchEvent(
      new CustomEvent('spaNavigate', {
        detail: { view: 'search', searchQuery: query, searchType: this.searchFilter },
      }),
    );
  }

  private switchFilter(filter: 'posts' | 'arcade' | 'users'): void {
    if (this.activeFilter === filter) return;
    this.activeFilter = filter;

    // Update filter UI
    const filterBtns = this.element.querySelectorAll('.explore-filter-btn') as NodeListOf<HTMLElement>;
    filterBtns.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.filter === filter);
    });

    // Show/hide trending tags container
    const trendingTags = this.element.querySelector('.explore-trending-tags') as HTMLElement;
    if (trendingTags) {
      trendingTags.style.display = filter === 'posts' ? 'block' : 'none';
    }

    // Reset and load content for the new filter
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement;
    if (postsContainer) {
      postsContainer.innerHTML = '';
    }

    // If in tag view, tag view only shows posts
    if (this.props.tag && filter !== 'posts') {
      const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement;
      if (loadingElement) {
        loadingElement.style.display = 'block';
        loadingElement.innerHTML = '';
        const msg = document.createElement('div');
        msg.style.cssText =
          "text-align: center; padding: 3rem; color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;";
        msg.textContent = t('explore.tag_filter_unavailable');
        loadingElement.appendChild(msg);
      }
      return;
    }

    this.posts = [];
    this.arcadePosts = [];
    this.userSuggestions = [];
    this.cursor = undefined;
    this.hasMore = true;
    this.postCards.clear();

    void this.loadContent();
  }

  private getSearchHistory(): string[] {
    try {
      const raw = localStorage.getItem(ExplorePage.SEARCH_HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private saveSearchHistory(query: string): void {
    const history = this.getSearchHistory().filter((h) => h !== query);
    history.unshift(query);
    if (history.length > ExplorePage.MAX_HISTORY) history.pop();
    localStorage.setItem(ExplorePage.SEARCH_HISTORY_KEY, JSON.stringify(history));
  }

  private renderSearchHistory(dropdown: HTMLElement): void {
    const history = this.getSearchHistory();
    if (history.length === 0) return;

    dropdown.innerHTML = '';
    dropdown.style.display = 'block';

    const header = document.createElement('div');
    header.style.cssText =
      'padding: 0.5rem 0.75rem; font-size: 0.75rem; color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--border);';
    header.textContent = t('explore.recent_searches') || 'Recent';
    dropdown.appendChild(header);

    history.forEach((q) => {
      const item = document.createElement('div');
      item.style.cssText = `
        padding: 0.6rem 0.75rem; cursor: pointer; display: flex;
        align-items: center; gap: 0.5rem; transition: background 0.15s;
      `;
      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'none';
      });

      const icon = document.createElement('span');
      icon.textContent = '🕐';
      icon.style.cssText = 'font-size: 0.85rem; flex-shrink: 0;';

      const text = document.createElement('span');
      text.textContent = q;
      text.style.cssText =
        'color: var(--text-primary); font-size: 0.85rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

      item.appendChild(icon);
      item.appendChild(text);

      item.addEventListener('click', () => {
        dropdown.style.display = 'none';
        const input = this.element.querySelector('.search-input') as HTMLInputElement;
        if (input) {
          input.value = q;
          this.performSearch(q);
        }
      });

      dropdown.appendChild(item);
    });
  }

  private setupPostUpdatedListener(): void {
    this.postUpdatedHandler = createPostUpdatedHandler(this.postCards);
    window.addEventListener('postUpdated', this.postUpdatedHandler);
  }

  private renderPosts(): void {
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement;
    if (!postsContainer) return;

    // If initial load, clear container
    if (this.posts.length <= 10 && postsContainer.children.length > 0 && !this.cursor) {
      postsContainer.innerHTML = '';
      this.postCards.clear();
    }

    const fragment = document.createDocumentFragment();
    const startIndex = postsContainer.children.length;

    this.posts.slice(startIndex).forEach((post) => {
      const postCard = createPostCard({
        post,
        sandboxOrigin: this.props.sandboxOrigin,
        currentUser: this.props.currentUser || undefined,
        depth: post.depth,
      });
      this.postCards.set(post.id, postCard);
      fragment.appendChild(postCard.getElement());
    });

    postsContainer.appendChild(fragment);
  }

  private renderTrendingTags(tags: Array<{ tag: string; count: number; percentage?: number }>): void {
    const container = this.element.querySelector('.explore-trending-tags') as HTMLElement;
    if (!container) return;

    container.innerHTML = `<h2 class="explore-trending-heading">${t('explore.trending_tags')}</h2>`;
    container.style.display = 'block';

    const maxCount = Math.max(...tags.map(({ count }) => count), 1);

    tags.forEach(({ tag, count, percentage }) => {
      const item = document.createElement('a');
      item.className = 'trending-item';
      item.href = `/explore?tag=${encodeURIComponent(tag)}`;
      item.dataset.count = String(count);

      const name = document.createElement('div');
      name.className = 'trending-tag-name';
      name.textContent = `# ${tag}`;

      // Bars compare tags with each other; the text keeps the true share of
      // the recent-post sample so the graph cannot overstate a tag.
      const bar = document.createElement('div');
      bar.className = 'trending-bar';
      bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span');
      fill.className = 'trending-bar-fill';
      fill.style.width = `${relativeBarPercent(count, maxCount)}%`;
      bar.appendChild(fill);

      const pct = typeof percentage === 'number' && Number.isFinite(percentage) ? percentage : null;
      const meta = document.createElement('div');
      meta.className = 'trending-tag-meta';
      meta.textContent =
        pct === null
          ? t('right_panel.trending_count', { count })
          : `${t('explore.trending_percent', { percentage: formatPercentage(pct) })} · ${t('right_panel.trending_count', { count })}`;

      item.appendChild(name);
      item.appendChild(bar);
      item.appendChild(meta);

      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(tag)}`);
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore', tag } }));
      });
      container.appendChild(item);
    });
  }

  private renderArcadePosts(): void {
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement;
    if (!postsContainer) return;

    if (this.arcadePosts.length === postsContainer.children.length && postsContainer.children.length > 0) {
      return;
    }

    if (postsContainer.children.length === 0 || this.arcadePosts.length <= postsContainer.children.length) {
      if (this.arcadePosts.length <= 10) {
        postsContainer.innerHTML = '';
      }
    }

    const fragment = document.createDocumentFragment();
    const startIndex = postsContainer.children.length;

    this.arcadePosts.slice(startIndex).forEach((game) => {
      const row = document.createElement('div');
      row.className = 'explore-arcade-row';
      row.onclick = () => {
        pushSpaHistory(`/arcade/${game.postId}`, { postId: game.postId });
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'arcade', postId: game.postId } }));
      };

      const thumb = document.createElement('div');
      thumb.className = 'explore-arcade-thumb';

      if (game.thumbnailKey) {
        const img = document.createElement('img');
        img.src = nativeApiHref(`/api/thumbnail/${game.postId}`);
        img.alt = '';
        img.loading = 'lazy';
        img.width = 180;
        img.height = 101;
        thumb.appendChild(img);
      } else {
        const fallback = document.createElement('div');
        fallback.style.cssText =
          'width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 2rem;';
        fallback.textContent = '🎮';
        thumb.appendChild(fallback);
      }

      const info = document.createElement('div');
      info.className = 'explore-arcade-info';

      const title = document.createElement('div');
      title.className = 'explore-arcade-title';
      title.textContent = game.title;

      const meta = document.createElement('div');
      meta.className = 'explore-arcade-meta';

      const author = document.createElement('span');
      author.textContent = `@${game.username}`;

      const engagement = document.createElement('span');
      const freshStr = Number.isNaN(game.freshCount) ? '0' : formatCount(game.freshCount);
      engagement.textContent = `${freshStr} 💚`;

      meta.appendChild(author);
      meta.appendChild(engagement);
      info.appendChild(title);
      info.appendChild(meta);

      row.appendChild(thumb);
      row.appendChild(info);
      fragment.appendChild(row);
    });

    postsContainer.appendChild(fragment);
  }

  private renderUserSuggestions(): void {
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement;
    if (!postsContainer) return;
    postsContainer.innerHTML = '';

    if (this.userSuggestions.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'page-empty';
      const icon = document.createElement('span');
      icon.className = 'page-empty-icon';
      const title = document.createElement('p');
      title.className = 'page-empty-title fx-display';
      title.textContent = t('explore.no_users');
      msg.appendChild(icon);
      msg.appendChild(title);
      postsContainer.appendChild(msg);
      return;
    }

    this.userSuggestions.forEach((user) => {
      const item = document.createElement('div');
      item.className = 'explore-user-row';
      item.onclick = () => {
        window.history.pushState({ username: user.username }, '', `/profile/${user.username}`);
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'profile', username: user.username } }));
      };

      const avatar = document.createElement('div');
      avatar.className = 'explore-avatar';
      if (user.avatar_key) {
        avatar.style.backgroundImage = `url('${nativeApiHref(`/api/images/${user.avatar_key}`)}')`;
      }
      if (!user.avatar_key) {
        avatar.textContent = user.display_name?.[0]?.toUpperCase() || user.username[0].toUpperCase();
      }
      attachPlusBadge(avatar, user.badge_type);

      const userInfo = document.createElement('div');
      userInfo.className = 'explore-user-info';
      const usernameEl = document.createElement('div');
      usernameEl.className = 'explore-user-name';
      usernameEl.textContent = `@${user.username}`;
      const displayNameEl = document.createElement('div');
      displayNameEl.className = 'explore-user-display';
      displayNameEl.textContent = user.display_name || '';
      applyNameColor(displayNameEl, user.name_color, user.badge_type);

      userInfo.appendChild(usernameEl);
      userInfo.appendChild(displayNameEl);
      item.appendChild(avatar);
      item.appendChild(userInfo);
      postsContainer.appendChild(item);
    });
  }

  private updateLoadingState(isLoading: boolean): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement;
    if (loadingElement) {
      loadingElement.style.display = isLoading ? 'block' : 'none';
      if (isLoading) {
        loadingElement.innerHTML = '';
        loadingElement.appendChild(createSkeletonCards(2));
      }
    }
  }

  private showEndOfPosts(): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement;
    if (loadingElement) {
      loadingElement.style.display = 'block';
      loadingElement.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.className = 'explore-end';

      const icon = document.createElement('div');
      icon.className = 'explore-end-icon';
      icon.textContent = t('explore.end_icon');

      const title = document.createElement('div');
      title.textContent = t('explore.end_message');

      const subtitle = document.createElement('div');
      subtitle.className = 'explore-end-subtitle';
      subtitle.textContent = t('explore.end_subtitle', { tag: this.props.tag ?? '' });

      wrapper.appendChild(icon);
      wrapper.appendChild(title);
      wrapper.appendChild(subtitle);
      loadingElement.appendChild(wrapper);
    }
  }

  private showLoadError(): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement;
    if (loadingElement) {
      loadingElement.style.display = 'block';
      loadingElement.innerHTML = '';

      const wrapper = document.createElement('div');
      wrapper.className = 'explore-load-error';

      const icon = document.createElement('div');
      icon.className = 'explore-end-icon';
      icon.textContent = '⚠️';

      const title = document.createElement('div');
      title.textContent = t('explore.load_error');

      const retryBtn = document.createElement('button');
      retryBtn.className = 'explore-retry';
      retryBtn.textContent = t('common.retry');
      retryBtn.addEventListener('click', () => {
        loadingElement.style.display = 'none';
        void this.loadMorePosts();
      });

      wrapper.appendChild(icon);
      wrapper.appendChild(title);
      wrapper.appendChild(retryBtn);
      loadingElement.appendChild(wrapper);
    }
  }

  private handleNewPost(post: Post): void {
    this.posts = [post, ...this.posts];
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement;
    if (postsContainer) {
      postsContainer.insertBefore(
        createPostCard({
          post,
          sandboxOrigin: this.props.sandboxOrigin,
          currentUser: this.props.currentUser || undefined,
        }).getElement(),
        postsContainer.firstChild,
      );
    }
    this.updateTagCount();
  }

  private updateTagCount(): void {
    if (this.tagCountEl && this.props.tag) {
      const count = this.totalTagCount || this.posts.length;
      this.tagCountEl.textContent = t('explore.tag_count', { count: formatCount(count) });
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.postUpdatedHandler) {
      window.removeEventListener('postUpdated', this.postUpdatedHandler);
    }
    this.postCards.forEach((card) => void card.destroy());
    this.postCards.clear();
    this.infiniteScroll.disconnect();
  }
}

// Factory function for easier usage
export function createExplorePage(props: ExplorePageProps): ExplorePage {
  return new ExplorePage(props);
}
