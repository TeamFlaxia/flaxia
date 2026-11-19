import { stripPostColors } from '../../shared/post-colors.ts';
import { Post } from '../../shared/types/post.ts';
import { createFabButton } from '../lib/fab-button.js';
import { t } from '../lib/i18n.js';
import { createInfiniteScroll } from '../lib/infinite-scroll.js';
import { createSkeletonCards } from '../lib/loading-ui.js';
import { nativeApiHref } from '../lib/native-api.js';
import { isNativeApp } from '../lib/native-api.ts';
import { createPageHeader } from '../lib/page-header.js';
import { openPostModal } from '../lib/post-modal.js';
import { createPostUpdatedHandler } from '../lib/post-update.js';
import { each, legacy, type Mounted, mount, type Signal, signal } from '../lib/render/index.ts';
import { pushSpaHistory } from '../lib/spa-history.js';
import { appendUniqueBy } from '../lib/unique.ts';
import { createOfflineDownloads } from './OfflineDownloads.ts';
import { createPostCard } from './PostCard.js';
import { isZipGame } from './PostStage.js';

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
  private arcadeSection: HTMLElement | null = null;
  private downloads?: ReturnType<typeof createOfflineDownloads>;
  private postsSignal: Signal<Post[]>;
  private listMount?: Mounted;

  constructor(props: BookmarksPageProps) {
    this.props = props;
    this.postsSignal = signal<Post[]>([]);
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

    const arcadeSection = document.createElement('div');
    if (isNativeApp()) {
      this.downloads = createOfflineDownloads();
      container.appendChild(this.downloads.element);
    }
    arcadeSection.className = 'bookmarks-arcade';
    arcadeSection.style.display = 'none';
    container.appendChild(arcadeSection);
    this.arcadeSection = arcadeSection;

    const postsContainer = document.createElement('div');
    postsContainer.className = 'bookmarks-posts';
    postsContainer.style.width = '100%';
    container.appendChild(postsContainer);

    this.listMount = mount(postsContainer, () =>
      each(
        () => this.postsSignal(),
        (post) => post.id,
        (post) => {
          const value = post();
          try {
            const postCard = createPostCard({
              post: value,
              sandboxOrigin: this.props.sandboxOrigin,
              currentUser: this.props.currentUser || undefined,
              depth: value.depth,
            });
            this.postCards.set(value.id, postCard);
            return legacy(postCard.getElement(), () => {
              postCard.destroy();
              this.postCards.delete(value.id);
            });
          } catch (error) {
            console.error('Failed to render bookmark post:', error);
            return document.createComment('bookmark-render-failed');
          }
        },
      ),
    );

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
        this.posts = appendUniqueBy(this.posts, newPosts, (post) => post.id);
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
    postsContainer?.querySelector('.page-empty')?.remove();
    this.postsSignal.set([...this.posts]);
    this.updateArcadeSection();
  }

  private isGamePost(post: Post): boolean {
    return isZipGame(post.payload_key) || (!!post.swf_key && post.swf_key.startsWith('swf/'));
  }

  private updateArcadeSection(): void {
    const section = this.arcadeSection;
    if (!section) return;

    const gamePosts = this.posts.filter((p) => this.isGamePost(p));
    if (gamePosts.length === 0) {
      section.style.display = 'none';
      section.innerHTML = '';
      return;
    }

    section.style.display = '';
    section.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'bookmarks-section-title';
    title.textContent = t('explore.filter_arcade');
    section.appendChild(title);

    const wrapper = document.createElement('div');
    wrapper.className = 'bookmarks-rail-wrapper';

    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'bookmarks-rail';
    scrollContainer.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
        e.preventDefault();
        scrollContainer.scrollLeft += e.deltaY;
      }
    });

    const fadeHint = document.createElement('div');
    fadeHint.className = 'bookmarks-rail-fade';
    wrapper.appendChild(fadeHint);

    const updateFade = () => {
      const atEnd = scrollContainer.scrollLeft >= scrollContainer.scrollWidth - scrollContainer.clientWidth - 4;
      fadeHint.style.opacity = atEnd ? '0' : '1';
    };
    scrollContainer.addEventListener('scroll', updateFade);

    for (const post of gamePosts) {
      const card = document.createElement('div');
      card.className = 'bookmark-card';
      card.addEventListener('click', () => {
        pushSpaHistory(`/arcade/${post.id}`, { postId: post.id });
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'arcade', postId: post.id } }));
      });

      const thumb = document.createElement('div');
      thumb.className = 'bookmark-thumb';
      if (post.thumbnail_key) {
        const img = document.createElement('img');
        img.src = nativeApiHref(`/api/images/${post.thumbnail_key}`);
        img.loading = 'lazy';
        img.width = 150;
        img.height = 200;
        thumb.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.className = 'bookmark-thumb-icon';
        icon.textContent = '🎮';
        thumb.appendChild(icon);
      }

      const badge = document.createElement('span');
      badge.className = 'bookmark-badge';
      badge.textContent = 'GAME';
      thumb.appendChild(badge);

      const info = document.createElement('div');
      info.className = 'bookmark-info';

      const cardTitle = document.createElement('div');
      cardTitle.className = 'bookmark-title';
      cardTitle.textContent = stripPostColors(post.text || '').slice(0, 60) || '(no text)';

      const meta = document.createElement('div');
      meta.className = 'bookmark-meta';
      meta.textContent = `@${post.username}`;

      info.appendChild(cardTitle);
      info.appendChild(meta);
      card.appendChild(thumb);
      card.appendChild(info);
      scrollContainer.appendChild(card);
    }

    wrapper.appendChild(scrollContainer);
    section.appendChild(wrapper);

    requestAnimationFrame(updateFade);
  }

  private showEmpty(): void {
    const postsContainer = this.element.querySelector('.bookmarks-posts') as HTMLElement;
    const empty = document.createElement('div');
    empty.className = 'page-empty';
    const emptyIcon = document.createElement('span');
    emptyIcon.className = 'page-empty-icon';
    const emptyTitle = document.createElement('p');
    emptyTitle.className = 'page-empty-title fx-display';
    emptyTitle.textContent = t('bookmarks.empty') || 'No bookmarks yet';
    const emptyCta = document.createElement('button');
    emptyCta.type = 'button';
    emptyCta.className = 'page-empty-cta';
    emptyCta.textContent = t('nav.explore');
    emptyCta.addEventListener('click', () => {
      window.history.pushState({}, '', '/explore');
      window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore' } }));
    });
    empty.appendChild(emptyIcon);
    empty.appendChild(emptyTitle);
    empty.appendChild(emptyCta);
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
    const msg = document.createElement('p');
    msg.textContent = this.error;

    const retryBtn = document.createElement('button');
    retryBtn.className = 'bookmarks-retry';
    retryBtn.textContent = t('bookmarks.retry') || 'Retry';
    retryBtn.addEventListener('click', () => {
      this.posts = [];
      this.cursor = undefined;
      this.hasMore = true;
      this.postsSignal.set([]);
      this.element.querySelector('.page-empty')?.remove();
      this.hideError();
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
        loadingElement.appendChild(createSkeletonCards(2));
      }
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.downloads?.destroy();
    if (this.postUpdatedHandler) {
      window.removeEventListener('postUpdated', this.postUpdatedHandler);
    }
    // The mount disposer calls each legacy card's destroy via its cleanup.
    this.listMount?.dispose();
    this.listMount = undefined;
    this.postCards.clear();
    this.infiniteScroll.disconnect();
  }
}

export function createBookmarksPage(props: BookmarksPageProps): BookmarksPage {
  return new BookmarksPage(props);
}
