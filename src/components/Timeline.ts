import { getMe } from '../lib/auth-cache.js';
import { t } from '../lib/i18n.js';
import { injectAds } from '../lib/inject-ads.js';
import { openPostModal } from '../lib/post-modal.js';
import { Ad, isAd, Post, PostCardMode, TimelineProps, TimelineState } from '../types/post.js';
import { createAdCard } from './AdCard.js';
import { createPostCard } from './PostCard.js';
import { createPostComposer, PostComposer } from './PostComposer.js';
import { createSkeletonCard } from './SkeletonCard.js';

export class Timeline {
  private element: HTMLElement;
  private props: TimelineProps;
  private state: TimelineState;
  private postCards: Map<string, ReturnType<typeof createPostCard>> = new Map();
  private composer!: PostComposer;
  private fabButton?: HTMLElement;
  private composerObserver: IntersectionObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private loadMoreSentinel: HTMLElement | null = null;

  // Store bound event handlers for proper cleanup
  private boundHandleProfileUpdate: () => void;
  private boundHandleResize: () => void;
  private boundHandlePostUpdated: (e: Event) => void;

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
    this.boundHandleResize = this.updateSwipeHint.bind(this);
    this.boundHandlePostUpdated = this.handlePostUpdated.bind(this);

    this.element = this.createElement();
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

    // Post composer directly below the header (only for logged-in users)
    if (this.props.currentUser) {
      this.composer = createPostComposer({
        onPostCreated: (post) => this.handleNewPost(post),
        currentUser: this.props.currentUser,
      });
      container.appendChild(this.composer.getElement());
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
      this.fabButton = document.createElement('button');
      this.fabButton.className = 'timeline-fab';
      this.fabButton.textContent = '+';
      this.fabButton.addEventListener('click', () => this.openPostModal());
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

    // Show skeleton cards while loading initial posts
    if (this.state.loading && this.state.posts.length === 0) {
      for (let i = 0; i < 3; i++) {
        list.appendChild(createSkeletonCard());
      }
    }

    return list;
  }

  private createLoadMore(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'load-more-container';

    // Create sentinel element for intersection observer
    this.loadMoreSentinel = document.createElement('div');
    this.loadMoreSentinel.className = 'load-more-sentinel';
    this.loadMoreSentinel.style.cssText = `
      height: 100px;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    // Add loading spinner (hidden by default)
    const loadingSpinner = document.createElement('div');
    loadingSpinner.className = 'loading-spinner';

    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const spinnerLabel = document.createElement('span');
    spinnerLabel.textContent = t('common.loading');
    loadingSpinner.appendChild(spinner);
    loadingSpinner.appendChild(spinnerLabel);
    loadingSpinner.style.cssText = `
      display: none;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 0.875rem;
      color: var(--text-muted);
    `;

    // Add skeleton cards for loading more posts
    const skeletonContainer = document.createElement('div');
    skeletonContainer.className = 'skeleton-more';
    skeletonContainer.style.display = 'none';

    for (let i = 0; i < 2; i++) {
      skeletonContainer.appendChild(createSkeletonCard());
    }

    container.appendChild(this.loadMoreSentinel);
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
    this.element.addEventListener('replyToggle', (e: any) => {
      const postId = e.detail.postId;
      this.handleReplyToggle(postId);
    });

    // Thread navigation events - listen for navigateToThread events from post cards
    this.element.addEventListener('navigateToThread', (e: any) => {
      const postId = e.detail.postId;
      console.log('Timeline received navigateToThread event for postId:', postId);
      // Let the main app handle this navigation
      console.log('Navigate to thread:', postId);
    });

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

    // Setup intersection observer for infinite scroll
    this.setupIntersectionObserver();

    // Listen for profile updates to refresh composer avatar
    window.addEventListener('profileUpdated', this.boundHandleProfileUpdate);

    // Listen for post updates (e.g. fresh/like toggles from other views)
    window.addEventListener('postUpdated', this.boundHandlePostUpdated);

    // Setup swipe detection for mobile left nav
    this.setupSwipeDetection();
  }

  private setupSwipeDetection(): void {
    // Mobile left nav gestures are disabled. Navigation is opened only by the explicit menu button.
    return;
  }

  private updateSwipeHint(): void {
    const hint = document.querySelector('.left-nav-swipe-hint') as HTMLElement;
    if (hint) {
      if (window.innerWidth <= 768) {
        hint.style.display = 'block';
      } else {
        hint.style.display = 'none';
      }
    }
  }

  private handleNewPost(post: any): void {
    // Add the new post to the beginning of the timeline
    this.state.posts = [post, ...this.state.posts];
    this.renderPostList();
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
      this.composer.updateCurrentUser({
        username: updatedUser.user.username,
        display_name: updatedUser.user.display_name,
        avatar_key: updatedUser.user.avatar_key,
      });
    }
  }

  private handlePostUpdated(e: Event): void {
    const detail = (e as CustomEvent).detail;
    const postCard = this.postCards.get(detail.postId);
    if (postCard) {
      const update: Partial<Post> = {};
      if (detail.isFreshed !== undefined) update.is_freshed = detail.isFreshed;
      if (detail.freshCount !== undefined) update.fresh_count = detail.freshCount;
      if (detail.isBookmarked !== undefined) update.is_bookmarked = detail.isBookmarked;
      if (detail.bookmarkCount !== undefined) update.bookmark_count = detail.bookmarkCount;
      if (detail.replyCount !== undefined) update.reply_count = detail.replyCount;
      postCard.updatePost(update);
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
        if (entry.isIntersecting && !this.state.loading && this.state.hasMore) {
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

  private resetAndLoadPosts(): void {
    this.state.posts = [];
    this.state.ads = [];
    this.state.cursor = undefined;
    this.state.hasMore = true;
    this.postCards.clear();
    this.renderPostList();

    // Re-setup intersection observer for new content
    this.setupIntersectionObserver();

    // Load ads and posts in parallel
    Promise.all([this.loadInitialPosts(), this.loadAdConfig()]);
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

      const data = (await response.json()) as { posts: Post[] };

      // Inject ads into posts
      const postsWithAds = injectAds(data.posts, this.state.ads, this.state.everyN);
      this.state.posts = postsWithAds;

      if (data.posts.length > 0) {
        this.state.cursor = data.posts[data.posts.length - 1].created_at;
      }

      this.state.hasMore = data.posts.length === 20;
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

      const data = (await response.json()) as { posts: Post[] };

      // Inject ads into new posts
      const postsWithAds = injectAds(data.posts, this.state.ads, this.state.everyN);
      this.state.posts = [...this.state.posts, ...postsWithAds];

      if (data.posts.length > 0) {
        this.state.cursor = data.posts[data.posts.length - 1].created_at;
      }

      this.state.hasMore = data.posts.length === 20;
      this.renderPostList();
    } catch (error) {
      console.error('Failed to load more posts:', error);
    } finally {
      this.state.loading = false;
      this.updateLoadingSpinner();
    }
  }

  private buildApiUrl(cursor?: string): string {
    const params = new URLSearchParams();
    params.set('limit', '20');

    if (cursor) {
      params.set('cursor', cursor);
    }

    if (this.state.mode === 'following') {
      // Following tab - filter to show only posts from followed users
      params.set('following', 'true');
      return `/api/posts?${params.toString()}`;
    } else {
      // For You / Global - same API endpoint, no following filter
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
            background: #f0f0f0;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #666;
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
        const postCard = createPostCard({
          post: item,
          currentUser: this.props.currentUser,
          sandboxOrigin: this.props.sandboxOrigin,
          initialMode: PostCardMode.PREVIEW,
          depth: item.depth,
        });

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
    if (this.loadMoreSentinel) {
      this.loadMoreSentinel.style.display = this.state.hasMore ? 'flex' : 'none';
    }
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
    // Clean up intersection observer
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }

    if (this.composerObserver) {
      this.composerObserver.disconnect();
      this.composerObserver = null;
    }

    // Clean up window event listeners
    window.removeEventListener('profileUpdated', this.boundHandleProfileUpdate);
    window.removeEventListener('postUpdated', this.boundHandlePostUpdated);
    window.removeEventListener('resize', this.boundHandleResize);

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
