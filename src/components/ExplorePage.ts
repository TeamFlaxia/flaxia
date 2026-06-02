import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { openPostModal } from '../lib/post-modal.js';
import { Post } from '../types/post.js';
import { createPostCard } from './PostCard.js';
import { createSkeletonCard } from './SkeletonCard.js';

export interface ExplorePageProps {
  tag?: string;
  sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
}

export class ExplorePage {
  private element: HTMLElement;
  private props: ExplorePageProps;
  private posts: Post[] = [];
  private cursor?: string;
  private loading = false;
  private hasMore = true;
  private intersectionObserver: IntersectionObserver | null = null;
  private loadMoreSentinel: HTMLElement | null = null;
  private searchFilter: 'posts' | 'users' | 'arcade' = 'posts';
  private fabButton: HTMLElement | null = null;
  private tagCountEl: HTMLElement | null = null;
  private totalTagCount: number = 0;
  private suggestAbortController: AbortController | null = null;
  private static readonly SEARCH_HISTORY_KEY = 'flaxia_search_history';
  private static readonly MAX_HISTORY = 10;

  constructor(props: ExplorePageProps) {
    this.props = props;
    this.element = this.createElement();
    this.setupEventListeners();
    this.loadContent();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'explore-page';

    // Add search section
    const searchSection = this.createSearchSection();
    container.appendChild(searchSection);

    if (this.props.tag) {
      // Tag view
      const tagHeader = document.createElement('div');
      tagHeader.className = 'explore-header explore-tag-header';
      tagHeader.style.cssText = `
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 1rem;
        border-bottom: 1px solid var(--border);
        position: sticky;
        top: 0;
        z-index: 10;
        background: var(--bg-primary);
      `;

      const backBtn = document.createElement('button');
      backBtn.className = 'explore-tag-back';
      backBtn.textContent = '←';
      backBtn.style.cssText = `
        background: none;
        border: none;
        font-size: 1.25rem;
        cursor: pointer;
        color: var(--text-primary);
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        transition: background 0.2s;
      `;
      backBtn.addEventListener('mouseenter', () => {
        backBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
      });
      backBtn.addEventListener('mouseleave', () => {
        backBtn.style.background = 'none';
      });
      backBtn.addEventListener('click', () => {
        window.history.back();
      });

      const tagInfo = document.createElement('div');
      tagInfo.style.cssText = 'display: flex; flex-direction: column;';

      const tagTitle = document.createElement('span');
      tagTitle.className = 'explore-title';
      tagTitle.textContent = `# ${this.props.tag}`;
      tagTitle.style.cssText = `
        font-size: 1.25rem;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.3;
      `;

      this.tagCountEl = document.createElement('span');
      this.tagCountEl.className = 'explore-tag-count';
      this.tagCountEl.textContent = t('explore.tag_count', { count: formatCount(0) });
      this.tagCountEl.style.cssText = `
        font-size: 0.8rem;
        color: var(--text-muted);
      `;

      tagInfo.appendChild(tagTitle);
      tagInfo.appendChild(this.tagCountEl);
      tagHeader.appendChild(backBtn);
      tagHeader.appendChild(tagInfo);
      container.appendChild(tagHeader);

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

    // Add sentinel for intersection observer
    this.loadMoreSentinel = document.createElement('div');
    this.loadMoreSentinel.className = 'explore-sentinel';
    this.loadMoreSentinel.style.cssText = `
      height: 100px;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 1rem;
    `;
    container.appendChild(this.loadMoreSentinel);

    if (this.props.currentUser) {
      this.fabButton = document.createElement('button');
      this.fabButton.className = 'timeline-fab visible';
      this.fabButton.textContent = '+';
      this.fabButton.addEventListener('click', () => {
        openPostModal({
          currentUser: this.props.currentUser,
          onPostCreated: (post) => this.handleNewPost(post),
        });
      });
      container.appendChild(this.fabButton);
    }

    return container;
  }

  private createSearchSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'explore-search-section';
    section.style.cssText = `
      padding: 1rem;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--bg-primary);
    `;

    const searchBox = document.createElement('div');
    searchBox.className = 'search-box';
    searchBox.style.cssText = 'position: relative; margin-bottom: 1rem;';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-input';
    input.placeholder = t('explore.search_placeholder');
    input.style.cssText =
      'width: 100%; padding: 0.75rem 1rem 0.75rem 2.5rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 9999px; color: var(--text-primary); font-family: inherit; font-size: 0.875rem; outline: none; transition: border-color 0.2s ease; box-sizing: border-box;';

    const icon = document.createElement('span');
    icon.className = 'search-icon';
    icon.style.cssText =
      'position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 0.875rem; pointer-events: none;';
    icon.textContent = '🔍';

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
              users: { username: string; display_name: string; avatar_key: string }[];
            };
            this.renderSuggestions(
              suggestDropdown,
              (data.users || []).map((u) => ({
                type: 'user' as const,
                label: u.username,
                display: u.display_name,
                avatar: u.avatar_key,
              })),
            );
          }
        } catch (err: any) {
          if (err?.name !== 'AbortError') console.error('Suggest error:', err);
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

    this.setupIntersectionObserver();
  }

  private renderSuggestions(
    dropdown: HTMLElement,
    items: { type: 'tag' | 'user'; label: string; count?: number; display?: string; avatar?: string }[],
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
        tagName.style.cssText = 'font-weight: 600; color: var(--accent); font-size: 0.875rem;';

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
          background: var(--accent); color: var(--bg-primary);
          display: flex; align-items: center; justify-content: center;
          font-weight: bold; font-size: 0.7rem; flex-shrink: 0;
        `;
        avatar.textContent = (it.display || it.label)[0].toUpperCase();

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
        await this.loadTrendingContent();
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
      } else {
        url = `/api/posts/trending?limit=10`;
      }

      if (this.cursor) {
        if (!this.props.tag && !this.cursor.includes(',')) {
          this.cursor = undefined;
        } else {
          url += `&cursor=${encodeURIComponent(this.cursor)}`;
        }
      }

      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to load more posts');

      const data = (await response.json()) as { posts: Post[] };
      const newPosts = data.posts || [];

      if (newPosts.length > 0) {
        this.posts.push(...newPosts);
        if (!this.props.tag) {
          const lastPost = newPosts[newPosts.length - 1] as any;
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
      const tagsData = await tagsRes.json();
      this.renderTrendingTags(tagsData.tags || []);
    }

    if (postsRes.ok) {
      const postsData = await postsRes.json();
      this.handleNewPosts(postsData.posts || []);
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

  private renderPosts(): void {
    const postsContainer = this.element.querySelector('.explore-posts') as HTMLElement;
    if (!postsContainer) return;

    // If initial load, clear container
    if (this.posts.length <= 10 && postsContainer.children.length > 0 && !this.cursor) {
      postsContainer.innerHTML = '';
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
      fragment.appendChild(postCard.getElement());
    });

    postsContainer.appendChild(fragment);
  }

  private renderTrendingTags(tags: any[]): void {
    const container = this.element.querySelector('.explore-trending-tags') as HTMLElement;
    if (!container) return;

    container.innerHTML = `<h2 style="padding: 1rem; font-size: 1.25rem; border-bottom: 1px solid var(--border);">${t('explore.trending_tags')}</h2>`;
    container.style.display = 'block';
    container.style.background = 'var(--bg-secondary)';
    container.style.marginBottom = '1rem';

    tags.forEach(({ tag, percentage }) => {
      const item = document.createElement('div');
      item.className = 'trending-item';
      item.style.cssText = `
        padding: 0.75rem 1rem;
        cursor: pointer;
        transition: background-color 0.2s ease;
        border-bottom: 1px solid var(--border);
      `;
      item.innerHTML = `
        <div style="color: var(--accent); font-weight: 600;"># ${tag}</div>
        <div style="font-size: 0.8rem; color: var(--text-muted);">${t('explore.trending_percent', { percentage })}</div>
      `;
      item.onclick = () => {
        window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(tag)}`);
        window.location.reload();
      };
      container.appendChild(item);
    });
  }

  private updateLoadingState(isLoading: boolean): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement;
    if (loadingElement) {
      loadingElement.style.display = isLoading ? 'block' : 'none';
      if (isLoading) {
        // Show skeleton cards while loading more posts
        loadingElement.innerHTML = '';
        for (let i = 0; i < 2; i++) {
          loadingElement.appendChild(createSkeletonCard());
        }
      }
    }
  }

  private showEndOfPosts(): void {
    const loadingElement = this.element.querySelector('.explore-loading') as HTMLElement;
    if (loadingElement) {
      loadingElement.style.display = 'block';
      loadingElement.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.style.cssText =
        "text-align: center; padding: 2rem; color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;";

      const icon = document.createElement('div');
      icon.style.cssText = 'font-size: 1.5rem; margin-bottom: 0.5rem;';
      icon.textContent = t('explore.end_icon');

      const title = document.createElement('div');
      title.textContent = t('explore.end_message');

      const subtitle = document.createElement('div');
      subtitle.style.cssText = 'font-size: 0.875rem; margin-top: 0.5rem;';
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
      wrapper.style.cssText =
        "text-align: center; padding: 2rem; color: var(--text-muted); font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;";

      const icon = document.createElement('div');
      icon.style.cssText = 'font-size: 1.5rem; margin-bottom: 0.5rem;';
      icon.textContent = '⚠️';

      const title = document.createElement('div');
      title.textContent = t('explore.load_error');

      const retryBtn = document.createElement('button');
      retryBtn.textContent = t('common.retry');
      retryBtn.style.cssText =
        'margin-top: 1rem; padding: 0.5rem 1rem; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-family: inherit;';
      retryBtn.addEventListener('click', () => {
        loadingElement.style.display = 'none';
        this.retryCount = 0;
        void this.loadMorePosts();
      });

      wrapper.appendChild(icon);
      wrapper.appendChild(title);
      wrapper.appendChild(retryBtn);
      loadingElement.appendChild(wrapper);
    }
  }

  private setupIntersectionObserver(): void {
    if (!this.loadMoreSentinel) return;

    // Disconnect existing observer if any
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
    }

    // Create new intersection observer optimized for mobile
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && !this.loading && this.hasMore) {
          // Immediate loading for better mobile performance
          this.loadMorePosts();
        }
      },
      {
        root: null, // Use viewport as root
        rootMargin: '300px', // Start loading 300px before sentinel comes into view (better for mobile)
        threshold: 0.1, // Trigger when 10% is visible (more reliable than 0.01)
      },
    );

    // Start observing sentinel
    this.intersectionObserver.observe(this.loadMoreSentinel);
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
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    window.removeEventListener('scroll', () => {});
  }
}

// Factory function for easier usage
export function createExplorePage(props: ExplorePageProps): ExplorePage {
  return new ExplorePage(props);
}
