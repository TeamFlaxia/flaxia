import { createFabButton } from '../lib/fab-button.js';
import { t } from '../lib/i18n.js';
import { createInfiniteScroll } from '../lib/infinite-scroll.js';
import { createPageHeader } from '../lib/page-header.js';
import { openPostModal } from '../lib/post-modal.js';
import { createPostUpdatedHandler } from '../lib/post-update.js';
import { Post } from '../types/post.js';
import { createPostCard } from './PostCard.js';
import { createSkeletonCard } from './SkeletonCard.js';

export interface BookmarksPageProps {
  sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
}

export class BookmarksPage {
  private element: HTMLElement;
  private props: BookmarksPageProps;
  private posts: Post[] = [];
  private cursor?: string;
  private loading = false;
  private hasMore = true;
  private error: string | null = null;
  private infiniteScroll: ReturnType<typeof createInfiniteScroll>;
  private fabButton: HTMLElement | null = null;
  private postCards: Map<string, ReturnType<typeof createPostCard>> = new Map();
  private postUpdatedHandler?: (e: Event) => void;

  constructor(props: BookmarksPageProps) {
    this.props = props;
    this.infiniteScroll = createInfiniteScroll({
      onLoadMore: () => this.loadContent(),
      canLoadMore: () => !this.loading && this.hasMore,
    });
    this.element = this.createElement();
    this.setupPostUpdatedListener();
    this.loadContent();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'bookmarks-page';

    container.appendChild(
      createPageHeader({
        title: t('nav.bookmarks'),
        onBack: () => window.history.back(),
      }),
    );

    const postsContainer = document.createElement('div');
    postsContainer.className = 'bookmarks-posts';
    postsContainer.style.width = '100%';
    container.appendChild(postsContainer);

    const loadingContainer = document.createElement('div');
    loadingContainer.className = 'bookmarks-loading';
    loadingContainer.style.display = 'none';
    container.appendChild(loadingContainer);

    container.appendChild(this.infiniteScroll.sentinel);

    if (this.props.currentUser) {
      this.fabButton = createFabButton(() => {
        openPostModal({
          currentUser: this.props.currentUser,
          onPostCreated: () => {},
        });
      }, true);
      container.appendChild(this.fabButton);
    }

    return container;
  }

  private async loadContent(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    this.hideError();
    this.updateLoadingState(true);

    try {
      let url = `/api/bookmarks?limit=10`;
      if (this.cursor) url += `&cursor=${encodeURIComponent(this.cursor)}`;

      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load bookmarks');

      const data = (await response.json()) as { posts: Post[]; nextCursor?: string };
      const newPosts = data.posts || [];

      if (newPosts.length > 0) {
        this.posts.push(...newPosts);
        this.cursor = newPosts[newPosts.length - 1].created_at;
        this.hasMore = newPosts.length === 10;
        this.renderPosts();
      } else {
        this.hasMore = false;
        if (this.posts.length === 0) this.showEmpty();
      }
    } catch (error) {
      console.error('Failed to load bookmarks:', error);
      this.error = t('bookmarks.error') || 'Failed to load bookmarks. Please try again.';
      this.showError();
    } finally {
      this.loading = false;
      this.updateLoadingState(false);
    }
  }

  private setupPostUpdatedListener(): void {
    this.postUpdatedHandler = createPostUpdatedHandler(this.postCards);
    window.addEventListener('postUpdated', this.postUpdatedHandler);
  }

  private renderPosts(): void {
    const postsContainer = this.element.querySelector('.bookmarks-posts') as HTMLElement;
    if (!postsContainer) return;

    const fragment = document.createDocumentFragment();
    const startIndex = postsContainer.children.length;

    for (let i = startIndex; i < this.posts.length; i++) {
      try {
        const postCard = createPostCard({
          post: this.posts[i],
          sandboxOrigin: this.props.sandboxOrigin,
          currentUser: this.props.currentUser || undefined,
          depth: this.posts[i].depth,
        });
        this.postCards.set(this.posts[i].id, postCard);
        fragment.appendChild(postCard.getElement());
      } catch (err) {
        console.error('Failed to render bookmark post:', err);
      }
    }

    postsContainer.appendChild(fragment);
  }

  private showEmpty(): void {
    const postsContainer = this.element.querySelector('.bookmarks-posts') as HTMLElement;
    const empty = document.createElement('div');
    empty.style.cssText = `
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
    `;
    empty.textContent = t('bookmarks.empty') || 'No bookmarks yet';
    if (postsContainer) {
      postsContainer.appendChild(empty);
    } else {
      this.element.appendChild(empty);
    }
  }

  private showError(): void {
    const existing = this.element.querySelector('.bookmarks-error');
    if (existing) return;

    const errorEl = document.createElement('div');
    errorEl.className = 'bookmarks-error';
    errorEl.style.cssText = `
      text-align: center;
      padding: 48px 24px;
      color: var(--text-muted);
    `;
    const msg = document.createElement('p');
    msg.textContent = this.error;
    msg.style.marginBottom = '16px';

    const retryBtn = document.createElement('button');
    retryBtn.textContent = t('bookmarks.retry') || 'Retry';
    retryBtn.style.cssText = `
      padding: 8px 20px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--bg-primary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.875rem;
      transition: background 0.2s;
    `;
    retryBtn.addEventListener('mouseenter', () => {
      retryBtn.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))';
    });
    retryBtn.addEventListener('mouseleave', () => {
      retryBtn.style.background = 'var(--bg-primary)';
    });
    retryBtn.addEventListener('click', () => {
      this.posts = [];
      this.cursor = undefined;
      this.hasMore = true;
      const postsContainer = this.element.querySelector('.bookmarks-posts');
      if (postsContainer) postsContainer.innerHTML = '';
      this.loadContent();
    });

    errorEl.appendChild(msg);
    errorEl.appendChild(retryBtn);
    this.element.appendChild(errorEl);
  }

  private hideError(): void {
    const el = this.element.querySelector('.bookmarks-error');
    if (el) el.remove();
  }

  private updateLoadingState(isLoading: boolean): void {
    const loadingElement = this.element.querySelector('.bookmarks-loading') as HTMLElement;
    if (loadingElement) {
      loadingElement.style.display = isLoading ? 'block' : 'none';
      if (isLoading && this.posts.length === 0) {
        loadingElement.innerHTML = '';
        for (let i = 0; i < 2; i++) {
          loadingElement.appendChild(createSkeletonCard());
        }
      }
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

export function createBookmarksPage(props: BookmarksPageProps): BookmarksPage {
  return new BookmarksPage(props);
}
