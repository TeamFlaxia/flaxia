import { getMe } from '../lib/auth-cache.js';
import { createFabButton } from '../lib/fab-button.js';
import { t } from '../lib/i18n.js';
import { createInfiniteScroll } from '../lib/infinite-scroll.js';
import { injectAds } from '../lib/inject-ads.js';
import { createLoadingSpinner, createSkeletonCards } from '../lib/loading-ui.js';
import { openPostModal } from '../lib/post-modal.js';
import { createPostUpdatedHandler } from '../lib/post-update.js';
import { Ad, isAd, Post, PostCardMode, TimelineItem, TimelineProps, TimelineState } from '../types/post.js';
import { createAdCard } from './AdCard.js';
import { createPostCard } from './PostCard.js';
import { createPostComposer, PostComposer } from './PostComposer.js';

export class Timeline {
  private element: HTMLElement;
  private props: TimelineProps;
  private state: TimelineState;
  private postCards: Map<string, ReturnType<typeof createPostCard>> = new Map();
  private composer!: PostComposer;
  private fabButton?: HTMLElement;
  private composerObserver: IntersectionObserver | null = null;
  private headSentinel!: HTMLElement;
  private headObserver: IntersectionObserver | null = null;
  private infiniteScroll: ReturnType<typeof createInfiniteScroll>;
  private postUpdatedHandler?: (e: Event) => void;

  // How far above the viewport a rendered card must sit before infinite
  // scrolling removes it from the DOM, measured in viewport heights.
  private static readonly PRUNE_ABOVE_VIEWPORTS = 2;
  // Never prune when fewer than this many cards remain, so scrolling back up
  // doesn't hit an empty gap.
  private static readonly PRUNE_MIN_CARDS = 30;
  // How many pruned posts are restored at once when the user scrolls back up
  // toward the head of the timeline.
  private static readonly HEAD_RESTORE_CHUNK = 60;

  // Store bound event handlers for proper cleanup
  private boundHandleProfileUpdate: () => void;

  constructor(props: TimelineProps) {
    this.props = props;
    this.state = {
      mode: 'global',
      hashtag: '',
      posts: [],
      ads: [],
      everyN: 8,
      cursor: undefined,
      loading: false,
      hasMore: true,
      error: null,
      retryCount: 0,
      maxRetries: 3,
    };

    // Initialize bound event handlers for proper cleanup
    this.boundHandleProfileUpdate = this.handleProfileUpdate.bind(this);

    this.infiniteScroll = createInfiniteScroll({
      onLoadMore: () => this.loadMorePosts(),
      canLoadMore: () => !this.state.loading && this.state.hasMore && !!this.state.cursor,
    });

    this.element = this.createElement();
    this.setupHeadObserver();
    this.setupEventListeners();
    this.setupComposerObserver();

    // Load ads first, then posts
    this.loadAdConfig().then(() => {
      this.loadInitialPosts();
    });
  }

  private createElement(): HTMLElement {
    const container = document.createElement('section');
    container.className = 'timeline';

    // Header: feed tabs
    const timelineHeader = document.createElement('div');
    timelineHeader.className = 'timeline-header';

    const feedToggle = this.createFeedToggle();
    timelineHeader.appendChild(feedToggle);

    container.appendChild(timelineHeader);

    // Post composer directly below the header (only for logged-in users);
    // guests see an Arcade promo card instead
    if (this.props.currentUser) {
      this.composer = createPostComposer({
        onPostCreated: (post) => this.handleNewPost(post as unknown as Post),
        currentUser: this.props.currentUser,
      });
      container.appendChild(this.composer.getElement());
    } else {
      container.appendChild(this.createArcadePromo());
    }

    // Hashtag input (hidden by default)
    const hashtagInput = this.createHashtagInput();
    container.appendChild(hashtagInput);

    // Post list
    const postList = this.createPostList();
    container.appendChild(postList);

    // Load more button
    const loadMore = this.createLoadMore();
    container.appendChild(loadMore);

    // FAB button for new post (only for logged-in users)
    if (this.props.currentUser) {
      this.fabButton = createFabButton(() => this.openPostModal());
      container.appendChild(this.fabButton);
    }

    return container;
  }

  private createFeedToggle(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'feed-toggle';

    // Mobile menu button (only visible on mobile)
    const menuBtn = document.createElement('button');
    menuBtn.className = 'feed-toggle-btn feed-menu-btn';
    menuBtn.textContent = t('timeline.menu');
    menuBtn.title = t('timeline.menu_title');
    container.appendChild(menuBtn);

    // Only show Following tab for logged-in users
    if (this.props.currentUser) {
      const followingBtn = document.createElement('button');
      followingBtn.className = 'feed-toggle-btn';
      followingBtn.textContent = t('timeline.following');
      followingBtn.dataset.mode = 'following';
      if (this.state.mode === 'following') {
        followingBtn.classList.add('active');
      }
      container.appendChild(followingBtn);
    }

    const forYouBtn = document.createElement('button');
    forYouBtn.className = 'feed-toggle-btn';
    forYouBtn.textContent = t('timeline.for_you');
    forYouBtn.dataset.mode = 'foryou';
    if (this.state.mode === 'foryou') {
      forYouBtn.classList.add('active');
    }
    container.appendChild(forYouBtn);

    const globalBtn = document.createElement('button');
    globalBtn.className = 'feed-toggle-btn';
    globalBtn.textContent = t('timeline.global');
    globalBtn.dataset.mode = 'global';
    if (this.state.mode === 'global') {
      globalBtn.classList.add('active');
    }
    container.appendChild(globalBtn);

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'feed-toggle-btn feed-reload-btn';
    reloadBtn.textContent = t('timeline.reload');
    reloadBtn.title = t('timeline.reload_title');
    container.appendChild(reloadBtn);

    return container;
  }

  private createArcadePromo(): HTMLElement {
    const promo = document.createElement('div');
    promo.className = 'timeline-promo';

    const title = document.createElement('div');
    title.className = 'timeline-promo-title';
    title.textContent = t('timeline.promo_title');

    const desc = document.createElement('p');
    desc.className = 'timeline-promo-desc';
    desc.textContent = t('timeline.promo_desc');

    const arcadeBtn = document.createElement('button');
    arcadeBtn.type = 'button';
    arcadeBtn.className = 'timeline-promo-arcade-btn';
    arcadeBtn.textContent = t('timeline.promo_arcade_btn');
    arcadeBtn.addEventListener('click', () => {
      window.history.pushState({}, '', '/arcade');
      window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'arcade' } }));
    });

    promo.appendChild(title);
    promo.appendChild(desc);
    promo.appendChild(arcadeBtn);

    return promo;
  }

  private createHashtagInput(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'hashtag-input';
    container.style.display = 'none'; // Always hidden since we removed hashtag mode

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('timeline.hashtag_placeholder');
    input.className = 'hashtag-input-field';
    input.value = this.state.hashtag;

    const searchBtn = document.createElement('button');
    searchBtn.className = 'hashtag-search-btn';
    searchBtn.textContent = t('timeline.search');

    container.appendChild(input);
    container.appendChild(searchBtn);

    return container;
  }

  private createPostList(): HTMLElement {
    const list = document.createElement('div');
    list.className = 'post-list';

    // Sentinel at the head of the list. When the user scrolls back up to the
    // top of the rendered cards, restoreHeadPosts() re-inserts the pruned
    // posts above it.
    this.headSentinel = document.createElement('div');
    this.headSentinel.style.cssText = 'height: 1px; width: 100%; pointer-events: none;';
    list.appendChild(this.headSentinel);

    // Show skeleton cards while loading initial posts
    if (this.state.loading && this.state.posts.length === 0) {
      list.appendChild(createSkeletonCards(3));
    }

    return list;
  }

  private createLoadMore(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'load-more-container';

    // Use sentinel from shared infinite scroll utility
    container.appendChild(this.infiniteScroll.sentinel);

    // Add loading spinner (hidden by default)
    const loadingSpinner = createLoadingSpinner();
    loadingSpinner.style.cssText = `
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 0.875rem;
      color: var(--text-muted);
    `;

    // Add skeleton cards for loading more posts
    const skeletonContainer = document.createElement('div');
    skeletonContainer.className = 'skeleton-more';
    skeletonContainer.style.display = 'none';
    skeletonContainer.appendChild(createSkeletonCards(2));

    container.appendChild(loadingSpinner);
    container.appendChild(skeletonContainer);

    return container;
  }

  private setupEventListeners(): void {
    // Feed toggle
    this.element.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('feed-toggle-btn')) {
        if (target.classList.contains('feed-reload-btn')) {
          this.reloadPosts();
        } else if (target.classList.contains('feed-menu-btn')) {
          // Emit event to open left nav on mobile
          this.element.dispatchEvent(
            new CustomEvent('openLeftNav', {
              bubbles: true,
            }),
          );
        } else {
          const mode = (target as HTMLElement).dataset.mode as 'following' | 'foryou' | 'global';
          this.switchMode(mode);
        }
      }
    });

    // Reply toggle events - listen for replyToggle events from post cards
    this.element.addEventListener('replyToggle', ((e: Event) => {
      const postId = (e as CustomEvent).detail.postId;
      this.handleReplyToggle(postId);
    }) as EventListener);

    // Thread navigation events - listen for navigateToThread events from post cards
    this.element.addEventListener('navigateToThread', ((e: Event) => {
      const postId = (e as CustomEvent).detail.postId;
      console.log('Timeline received navigateToThread event for postId:', postId);
      // Let the main app handle this navigation
      console.log('Navigate to thread:', postId);
    }) as EventListener);

    // Hashtag search
    const hashtagInput = this.element.querySelector('.hashtag-search-btn') as HTMLButtonElement;
    const inputField = this.element.querySelector('.hashtag-input-field') as HTMLInputElement;

    hashtagInput?.addEventListener('click', () => {
      const hashtag = inputField.value.trim();
      if (hashtag && hashtag !== this.state.hashtag) {
        this.state.hashtag = hashtag;
        this.resetAndLoadPosts();
      }
    });

    inputField?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const hashtag = inputField.value.trim();
        if (hashtag && hashtag !== this.state.hashtag) {
          this.state.hashtag = hashtag;
          this.resetAndLoadPosts();
        }
      }
    });

    // Listen for profile updates to refresh composer avatar
    window.addEventListener('profileUpdated', this.boundHandleProfileUpdate);

    // Listen for post updates (e.g. fresh/like toggles from other views)
    this.postUpdatedHandler = createPostUpdatedHandler(this.postCards);
    window.addEventListener('postUpdated', this.postUpdatedHandler);
  }

  private handleNewPost(post: Post): void {
    this.state.posts = [post, ...this.state.posts];
    const postList = this.element.querySelector('.post-list') as HTMLElement;
    if (!postList) return;

    const postCard = this.buildPostCard(post);

    this.postCards.set(post.id, postCard);
    postList.insertBefore(postCard.getElement(), this.headSentinel.nextSibling);
    this.updateLoadMoreButton();
  }

  private handleReplyToggle(postId: string): void {
    // Find the post card and let it handle the inline reply composer
    const postCard = this.postCards.get(postId);
    if (postCard) {
      // PostCard will handle showing/hiding its inline reply composer
      postCard.handleReplyTogglePublic();
    }
  }

  private async handleProfileUpdate(): Promise<void> {
    // Refresh current user data from cache
    const updatedUser = await getMe();
    if (updatedUser?.user && this.composer) {
      const u = updatedUser.user as {
        username: string;
        display_name?: string;
        avatar_key?: string;
        badge_type?: string | null;
      };
      this.composer.updateCurrentUser({
        username: u.username,
        display_name: u.display_name,
        avatar_key: u.avatar_key,
        badge_type: u.badge_type,
      });
    }
  }

  private switchMode(mode: 'following' | 'foryou' | 'global'): void {
    if (mode === this.state.mode) return;

    this.state.mode = mode;

    // Update toggle buttons
    const toggleBtns = this.element.querySelectorAll('.feed-toggle-btn');
    toggleBtns.forEach((btn) => {
      btn.classList.remove('active');
      if ((btn as HTMLElement).dataset.mode === mode) {
        btn.classList.add('active');
      }
    });

    // Reset and load posts (hashtag input is always hidden now)
    this.resetAndLoadPosts();
  }

  private reloadPosts(): void {
    this.resetAndLoadPosts();
  }

  private resetAndLoadPosts(): void {
    this.state.posts = [];
    this.state.ads = [];
    this.state.cursor = undefined;
    this.state.hasMore = true;
    this.postCards.forEach((card) => void card.destroy());
    this.postCards.clear();
    this.renderPostList();

    // Re-setup intersection observer for new content
    this.infiniteScroll.reconnect();

    // Load ads and posts in parallel
    Promise.all([this.loadInitialPosts(), this.loadAdConfig()]);
  }

  /**
   * Keeps the timeline DOM bounded while the user scrolls infinitely. Cards
   * that have scrolled more than PRUNE_ABOVE_VIEWPORTS above the viewport are
   * fully destroyed (releasing their callbacks, audio contexts, and timers)
   * and removed, leaving at least PRUNE_MIN_CARDS rendered.
   */
  private pruneOffscreenCards(): void {
    const postList = this.element.querySelector('.post-list') as HTMLElement | null;
    if (!postList) return;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (viewportHeight <= 0) return;
    const pruneTop = -viewportHeight * Timeline.PRUNE_ABOVE_VIEWPORTS;

    // Cards are stacked newest-first, so walking from the start removes the
    // posts the user has already scrolled past.
    const cardElements = Array.from(postList.querySelectorAll('.post-card')) as HTMLElement[];
    for (let i = 0; i < cardElements.length; i++) {
      if (cardElements.length - (i + 1) < Timeline.PRUNE_MIN_CARDS) break;
      const cardElement = cardElements[i]!;
      if (cardElement.getBoundingClientRect().bottom > pruneTop) break;

      const postId = cardElement.dataset.postId;
      if (postId) {
        const card = this.postCards.get(postId);
        if (card) {
          card.destroy();
          this.postCards.delete(postId);
        }
      }
      cardElement.remove();
    }

    // Ad banners sit between cards and have no card instance to destroy.
    postList.querySelectorAll('.ad-banner').forEach((ad) => {
      const adElement = ad as HTMLElement;
      if (adElement.getBoundingClientRect().bottom <= pruneTop) {
        adElement.remove();
      }
    });
  }

  /**
   * Restores posts that were pruned from the head of the timeline once the
   * user scrolls back up toward it. The post data is still held in
   * state.posts, so no network request is needed; only the cards (and their
   * DOM) are rebuilt. Scroll anchoring keeps the viewport stable when the
   * restored content is inserted above the current cards.
   */
  private restoreHeadPosts(): void {
    const postList = this.element.querySelector('.post-list') as HTMLElement | null;
    if (!postList) return;

    const firstCard = postList.querySelector('.post-card') as HTMLElement | null;
    if (!firstCard) return;
    const firstId = firstCard.dataset.postId;
    if (!firstId) return;

    // Find the position of the first rendered post in the post-only ordering
    // of state.posts to learn how many head posts were pruned.
    let headIndex = -1;
    let postCount = 0;
    for (const item of this.state.posts) {
      if (isAd(item)) continue;
      if (item.id === firstId) {
        headIndex = postCount;
        break;
      }
      postCount++;
    }
    if (headIndex <= 0) return;

    // Collect the slice of items (posts and their interleaved ads) to restore.
    const restoreFrom = Math.max(0, headIndex - Timeline.HEAD_RESTORE_CHUNK);
    const restored: TimelineItem[] = [];
    let idx = 0;
    for (const item of this.state.posts) {
      if (isAd(item)) {
        if (idx >= restoreFrom && idx < headIndex) restored.push(item);
      } else {
        if (idx >= restoreFrom && idx < headIndex) restored.push(item);
        idx++;
      }
    }
    if (restored.length === 0) return;

    const fragment = document.createDocumentFragment();
    for (const item of restored) {
      if (isAd(item)) {
        fragment.appendChild(createAdCard(item));
      } else {
        const card = this.buildPostCard(item);
        this.postCards.set(item.id, card);
        fragment.appendChild(card.getElement());
      }
    }

    postList.insertBefore(fragment, firstCard);
  }

  private setupHeadObserver(): void {
    this.headObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          this.restoreHeadPosts();
        }
      },
      { root: null, rootMargin: '300px 0px 0px 0px', threshold: 0 },
    );
    this.headObserver.observe(this.headSentinel);
  }

  private buildPostCard(item: Post): ReturnType<typeof createPostCard> {
    return createPostCard({
      post: item,
      currentUser: this.props.currentUser,
      sandboxOrigin: this.props.sandboxOrigin,
      initialMode: PostCardMode.PREVIEW,
      depth: item.depth,
      onDelete: (postId) => {
        this.state.posts = this.state.posts.filter((p) => !isAd(p) && p.id !== postId);
        const card = this.postCards.get(postId);
        if (card) {
          card.destroy();
          this.postCards.delete(postId);
        }
      },
    });
  }

  private async loadInitialPosts(): Promise<void> {
    if (this.state.loading) return;

    this.state.loading = true;
    this.updateLoadMoreButton();

    try {
      const url = this.buildApiUrl();
      const response = await fetch(url, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to fetch posts');
      }

      const data = (await response.json()) as { posts?: Post[]; next_cursor?: string };

      // Ensure posts is an array (handle unexpected API responses)
      const postsArray = Array.isArray(data.posts) ? data.posts : [];

      // Inject ads into posts
      const postsWithAds = injectAds(postsArray, this.state.ads, this.state.everyN);
      this.state.posts = postsWithAds;

      if (postsArray.length > 0) {
        this.state.cursor = data.next_cursor || postsArray[postsArray.length - 1].created_at;
      }

      this.state.hasMore = postsArray.length === 20;
      this.renderPostList();

      // Dispatch ready event for scroll restoration
      this.element.dispatchEvent(new CustomEvent('timelineReady'));
    } catch (error) {
      console.error('Failed to load posts:', error);
    } finally {
      this.state.loading = false;
      this.updateLoadMoreButton();
    }
  }

  private async loadAdConfig(): Promise<void> {
    const [adsRes, configRes] = await Promise.all([
      fetch('/api/ads/active'),
      fetch('/api/admin/ads/config'), // returns { every_n: number }
    ]);
    if (adsRes.ok) {
      const adsData = (await adsRes.json()) as { ads: Ad[] };
      this.state.ads = adsData.ads;
    }
    if (configRes.ok) {
      const configData = (await configRes.json()) as { every_n: number };
      this.state.everyN = configData.every_n;
    }
  }

  private async loadMorePosts(): Promise<void> {
    if (this.state.loading || !this.state.hasMore || !this.state.cursor) return;

    this.state.loading = true;
    this.updateLoadingSpinner();

    try {
      const url = this.buildApiUrl(this.state.cursor);
      const response = await fetch(url, {
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to fetch more posts');
      }

      const data = (await response.json()) as { posts?: Post[]; next_cursor?: string };

      // Ensure posts is an array (handle unexpected API responses)
      const postsArray = Array.isArray(data.posts) ? data.posts : [];

      // Inject ads into new posts
      const postsWithAds = injectAds(postsArray, this.state.ads, this.state.everyN);
      this.state.posts = [...this.state.posts, ...postsWithAds];

      if (postsArray.length > 0) {
        this.state.cursor = data.next_cursor || postsArray[postsArray.length - 1].created_at;
      }

      this.state.hasMore = postsArray.length === 20;
      this.appendPosts(postsWithAds);
    } catch (error) {
      console.error('Failed to load more posts:', error);
    } finally {
      this.state.loading = false;
      this.updateLoadingSpinner();
    }
  }

  private appendPosts(newItems: TimelineItem[]): void {
    const postList = this.element.querySelector('.post-list') as HTMLElement;
    if (!postList || newItems.length === 0) return;

    const fragment = document.createDocumentFragment();

    newItems.forEach((item) => {
      if (isAd(item)) {
        fragment.appendChild(createAdCard(item));
      } else {
        const postCard = this.buildPostCard(item);
        this.postCards.set(item.id, postCard);
        fragment.appendChild(postCard.getElement());
      }
    });

    postList.appendChild(fragment);
    this.pruneOffscreenCards();
  }

  private buildApiUrl(cursor?: string): string {
    const params = new URLSearchParams();
    params.set('limit', '20');

    if (cursor) {
      params.set('cursor', cursor);
    }

    if (this.state.mode === 'following') {
      params.set('following', 'true');
      return `/api/posts?${params.toString()}`;
    } else if (this.state.mode === 'foryou') {
      return `/api/posts/recommended?${params.toString()}`;
    } else {
      return `/api/posts?${params.toString()}`;
    }
  }

  private renderPostList(): void {
    const postList = this.element.querySelector('.post-list') as HTMLElement;
    if (!postList) return;

    // Clear existing posts and ads
    const existingPosts = postList.querySelectorAll('.post-card, .ad-banner');
    existingPosts.forEach((post) => void post.remove());

    // Create ad placeholders first at the correct positions
    const adPlaceholders: HTMLElement[] = [];
    if (this.state.ads.length > 0) {
      const _shuffled = [...this.state.ads].sort(() => Math.random() - 0.5);
      this.state.posts.forEach((item, index) => {
        if (!isAd(item) && (index + 1) % this.state.everyN === 0) {
          const placeholder = document.createElement('div');
          placeholder.className = 'ad-placeholder-slot';
          placeholder.style.cssText = `
            position: relative;
            width: 100%;
            aspect-ratio: 16 / 9;
            background: var(--bg-tertiary);
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-muted);
            font-size: 14px;
          `;
          placeholder.innerHTML = t('timeline.loading_ad');
          postList.appendChild(placeholder);
          adPlaceholders.push(placeholder);
        }
      });
    }

    // Render posts immediately for text content (prioritize speed)
    const fragment = document.createDocumentFragment();

    this.state.posts.forEach((item, index) => {
      if (isAd(item)) {
        // Skip ads in main rendering - they're handled by placeholders
        return;
      } else {
        // Render text posts immediately (highest priority)
        const postCard = this.buildPostCard(item);

        this.postCards.set(item.id, postCard);

        // Insert post and check if we need to add an ad placeholder after it
        fragment.appendChild(postCard.getElement());

        if ((index + 1) % this.state.everyN === 0 && adPlaceholders.length > 0) {
          const adPlaceholder = adPlaceholders.shift();
          if (adPlaceholder) {
            fragment.appendChild(adPlaceholder);
          }
        }
      }
    });

    // Add all content at once for better performance
    postList.appendChild(fragment);

    // Now replace placeholders with actual ads
    setTimeout(() => {
      const placeholders = postList.querySelectorAll('.ad-placeholder-slot');
      const shuffled = [...this.state.ads].sort(() => Math.random() - 0.5);

      placeholders.forEach((placeholder, index) => {
        if (shuffled[index % shuffled.length]) {
          const adCard = createAdCard(shuffled[index % shuffled.length]);
          placeholder.replaceWith(adCard);
        }
      });
    }, 100); // Small delay to ensure DOM is ready

    // Update loading state
    this.updateLoadMoreButton();
  }

  private updateLoadMoreButton(): void {
    this.updateLoadingSpinner();
  }

  private updateLoadingSpinner(): void {
    const loadingSpinner = this.element.querySelector('.loading-spinner') as HTMLElement;
    const skeletonMore = this.element.querySelector('.skeleton-more') as HTMLElement;

    if (!loadingSpinner) return;

    if (this.state.loading) {
      loadingSpinner.style.display = 'block';
      if (skeletonMore && this.state.posts.length > 0) {
        skeletonMore.style.display = 'block';
      }
    } else {
      loadingSpinner.style.display = 'none';
      if (skeletonMore) {
        skeletonMore.style.display = 'none';
      }
    }

    // Hide sentinel when no more posts
    this.infiniteScroll.sentinel.style.display = this.state.hasMore ? 'flex' : 'none';
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  private setupComposerObserver(): void {
    if (!this.composer || !this.fabButton) return;
    this.composerObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        this.fabButton!.classList.toggle('visible', !entry.isIntersecting);
      },
      { threshold: 0 },
    );
    this.composerObserver.observe(this.composer.getElement());
  }

  private openPostModal(): void {
    openPostModal({
      currentUser: this.props.currentUser,
      onPostCreated: (post) => this.handleNewPost(post),
    });
  }

  public destroy(): void {
    // Clean up infinite scroll observer
    this.infiniteScroll.disconnect();

    if (this.headObserver) {
      this.headObserver.disconnect();
      this.headObserver = null;
    }

    if (this.composerObserver) {
      this.composerObserver.disconnect();
      this.composerObserver = null;
    }

    // Clean up window event listeners
    window.removeEventListener('profileUpdated', this.boundHandleProfileUpdate);
    if (this.postUpdatedHandler) {
      window.removeEventListener('postUpdated', this.postUpdatedHandler);
    }

    if (this.composer) {
      this.composer.destroy();
    }
    this.postCards.forEach((card) => void card.destroy());
    this.postCards.clear();
    this.element.remove();
  }
}

// Factory function for easier usage
export function createTimeline(props: TimelineProps): Timeline {
  return new Timeline(props);
}
