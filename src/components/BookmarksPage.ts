import { createFabButton } from '../lib/fab-button.js';
import { t } from '../lib/i18n.js';
import { createInfiniteScroll } from '../lib/infinite-scroll.js';
import { createSkeletonCards } from '../lib/loading-ui.js';
import { getSignedMediaUrl } from '../lib/media-token.js';
import { createPageHeader } from '../lib/page-header.js';
import { openPostModal } from '../lib/post-modal.js';
import { createPostUpdatedHandler } from '../lib/post-update.js';
import { Post } from '../types/post.js';
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

    const arcadeSection = document.createElement('div');
    arcadeSection.className = 'bookmarks-arcade';
    arcadeSection.style.display = 'none';
    container.appendChild(arcadeSection);
    this.arcadeSection = arcadeSection;

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
    title.textContent = t('explore.filter_arcade');
    title.style.cssText = `
      font-weight: 600;
      font-size: 1rem;
      color: var(--text-primary);
      margin-bottom: 0.75rem;
      padding: 0 0.25rem;
    `;
    section.appendChild(title);

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position: relative;';

    const scrollContainer = document.createElement('div');
    scrollContainer.style.cssText = `
      display: flex;
      overflow-x: auto;
      gap: 0.75rem;
      padding: 0.25rem 0 0.75rem;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
    `;
    scrollContainer.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
        e.preventDefault();
        scrollContainer.scrollLeft += e.deltaY;
      }
    });

    const fadeHint = document.createElement('div');
    fadeHint.style.cssText = `
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 48px;
      background: linear-gradient(to right, transparent, var(--bg-primary));
      pointer-events: none;
      opacity: 1;
      transition: opacity 0.3s;
      z-index: 1;
    `;
    wrapper.appendChild(fadeHint);

    const updateFade = () => {
      const atEnd = scrollContainer.scrollLeft >= scrollContainer.scrollWidth - scrollContainer.clientWidth - 4;
      fadeHint.style.opacity = atEnd ? '0' : '1';
    };
    scrollContainer.addEventListener('scroll', updateFade);

    for (const post of gamePosts) {
      const card = document.createElement('div');
      card.style.cssText = `
        width: 150px;
        flex-shrink: 0;
        cursor: pointer;
        border-radius: 0.75rem;
        overflow: hidden;
        transition: transform 0.2s, box-shadow 0.2s;
        scroll-snap-align: start;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
      `;
      card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateY(-3px)';
        card.style.boxShadow = '0 6px 16px rgba(0,0,0,0.15)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = 'none';
        card.style.boxShadow = 'none';
      });
      card.addEventListener('click', () => {
        window.history.pushState({ postId: post.id }, '', `/arcade/${post.id}`);
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'arcade', postId: post.id } }));
      });

      const thumb = document.createElement('div');
      thumb.style.cssText = `
        width: 100%;
        aspect-ratio: 9 / 12;
        overflow: hidden;
        position: relative;
        background: var(--bg-input);
      `;
      if (post.thumbnail_key) {
        const img = document.createElement('img');
        getSignedMediaUrl('image', post.thumbnail_key).then((url) => {
          img.src = url;
        });
        img.loading = 'lazy';
        img.width = 150;
        img.height = 200;
        img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
        thumb.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.textContent = '🎮';
        icon.style.cssText =
          'position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 2rem;';
        thumb.appendChild(icon);
      }

      const badge = document.createElement('span');
      badge.style.cssText = `
        position: absolute; top: 4px; right: 4px;
        padding: 0.1rem 0.35rem; border-radius: 4px;
        background: var(--accent); color: white;
        font-size: 0.6rem; font-weight: 600; text-transform: uppercase;
        line-height: 1.2;
      `;
      badge.textContent = 'GAME';
      thumb.appendChild(badge);

      const info = document.createElement('div');
      info.style.cssText = 'padding: 0.4rem 0.35rem 0.35rem;';

      const cardTitle = document.createElement('div');
      cardTitle.textContent = post.text?.slice(0, 60) || '(no text)';
      cardTitle.style.cssText = `
        font-weight: 600; color: var(--text-primary);
        font-size: 0.8rem; line-height: 1.3;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      `;

      const meta = document.createElement('div');
      meta.textContent = `@${post.username}`;
      meta.style.cssText = `
        font-size: 0.7rem; color: var(--text-muted);
        margin-top: 0.15rem;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      `;

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
        loadingElement.appendChild(createSkeletonCards(2));
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
