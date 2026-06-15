import { formatCount } from '../lib/format.js';
import { getLocale, t } from '../lib/i18n.js';
import { impressionTracker } from '../lib/impression-tracker.js';
import { loadLinkPreview } from '../lib/link-preview.js';
import { registerModal } from '../lib/modal-state.js';
import { useSandboxBridge } from '../lib/sandbox-bridge.js';
import { PostCardMode, PostCardProps } from '../types/post.js';
import { createPostActions } from './PostActions.js';
import { createPostHeader } from './PostHeader.js';
import { createPostStage, updatePostStage } from './PostStage.js';
import { createPostText } from './PostText.js';
import { createReplyComposer, ReplyComposer } from './ReplyComposer.js';
import { createShareModal } from './ShareModal.js';
import { showSignInPrompt } from './SignInPrompt.js';

export class PostCard {
  private element: HTMLElement;
  private props: PostCardProps;
  private mode: PostCardMode;
  private isFreshed: boolean;
  private isBookmarked: boolean;
  private freshCount: number;
  private bookmarkCount: number;
  private replyCount: number;
  private impressions: number;
  private impressionTracked: boolean = false;
  private postStageElement?: HTMLElement;
  private sandboxBridge?: ReturnType<typeof useSandboxBridge>;
  private replyComposer?: ReplyComposer;
  private isReplyComposerOpen: boolean = false;
  private menuDropdown?: HTMLElement;
  private freshLoading: boolean = false;
  private bookmarkLoading: boolean = false;
  private translatedText: string | null = null;
  private showingOriginal: boolean = true;
  private originalText: string;
  private isEditing: boolean = false;
  private editContainer: HTMLElement | null = null;
  private postTextContainer: HTMLElement | null = null;

  constructor(props: PostCardProps) {
    this.originalText = props.post.text;
    this.props = props;
    this.mode = props.initialMode || PostCardMode.PREVIEW;
    // Use is_freshed from API response if available, otherwise default to false
    this.isFreshed = props.post.is_freshed || false;
    this.isBookmarked = props.post.is_bookmarked || false;
    this.freshCount = props.post.fresh_count;
    this.bookmarkCount = props.post.bookmark_count;
    this.replyCount = props.post.reply_count || 0;
    this.impressions = props.post.impressions || 0;
    this.element = this.createElement();
    this.setupEventListeners();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('article');
    container.className = 'post-card';
    container.setAttribute('data-post-id', this.props.post.id);
    if (this.props.postIndex !== undefined) {
      container.setAttribute('data-post-index', String(this.props.postIndex));
    }
    const cursorStyle = this.props.disableNavigation ? 'default' : 'pointer';
    container.style.cssText = `max-width: 100%; overflow-x: hidden; box-sizing: border-box; word-break: break-word; cursor: ${cursorStyle};`;

    // Header container with ... menu
    const headerContainer = document.createElement('div');
    headerContainer.style.cssText = `
      display: flex;
      align-items: flex-start;
      position: relative;
    `;

    // Post index (left side)
    if (this.props.postIndex !== undefined) {
      const indexEl = document.createElement('span');
      indexEl.textContent = `${this.props.postIndex}`;
      indexEl.style.cssText = `
        color: #94a3b8;
        font-size: 0.8125rem;
        font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        margin-right: 0.5rem;
        flex-shrink: 0;
      `;
      headerContainer.appendChild(indexEl);
    }

    // Post header
    const header = createPostHeader({
      username: this.props.post.username,
      display_name: this.props.post.display_name,
      avatar_key: this.props.post.avatar_key,
      createdAt: this.props.post.created_at,
      editedAt: this.props.post.edited_at,
    });
    headerContainer.appendChild(header);

    // ... menu button
    const isOwnPost = this.props.currentUser?.username === this.props.post.username;
    const menuButton = this.createMenuButton(isOwnPost);
    menuButton.style.marginLeft = 'auto';
    headerContainer.appendChild(menuButton);

    container.appendChild(headerContainer);

    // Post text - 優先的にプレーンテキストで表示
    const displayText = this.props.stripLeadingPostRef
      ? this.props.post.text.replace(/^\s*>>\d+\s*/g, '').trimStart()
      : this.props.post.text;
    this.originalText = displayText;

    this.postTextContainer = document.createElement('div');
    this.postTextContainer.style.cssText = 'margin-bottom: 1rem;';

    const textElement = document.createElement('div');
    textElement.className = 'post-text';
    textElement.style.cssText = `
      line-height: 1.6;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
    `;
    textElement.textContent = displayText;
    this.postTextContainer.appendChild(textElement);

    // Translate button
    const authorLang = this.props.post.author_language;
    const currentLocale = getLocale();
    if (authorLang && authorLang !== currentLocale) {
      const translateBar = document.createElement('div');
      translateBar.style.cssText = 'margin-top: 0.5rem;';

      const translateBtn = document.createElement('button');
      translateBtn.className = 'translate-btn';
      translateBtn.textContent = `Translate to ${currentLocale.toUpperCase()}`;
      translateBtn.style.cssText = `
        font-size: 0.8rem;
        color: var(--accent);
        background: none;
        border: 1px solid var(--accent);
        border-radius: 4px;
        padding: 2px 8px;
        cursor: pointer;
      `;
      translateBtn.addEventListener('click', async () => {
        translateBtn.disabled = true;
        translateBtn.textContent = 'Translating...';
        try {
          const res = await fetch(`/api/posts/${this.props.post.id}/translate?target=${currentLocale}`, {
            method: 'POST',
          });
          if (!res.ok) {
            translateBtn.remove();
            return;
          }

          const poll = async (): Promise<void> => {
            const pollRes = await fetch(`/api/posts/${this.props.post.id}/translate?target=${currentLocale}`);
            if (!pollRes.ok) {
              translateBtn.remove();
              return;
            }
            const data = (await pollRes.json()) as { status: string; translated_text?: string };
            if (data.status === 'done' && data.translated_text) {
              this.translatedText = data.translated_text;
              this.showingOriginal = false;
              textElement.textContent = data.translated_text;
              translateBar.innerHTML = '';
              const showOriginal = document.createElement('button');
              showOriginal.textContent = 'Show original';
              showOriginal.style.cssText = `
                font-size: 0.8rem;
                color: var(--accent);
                background: none;
                border: none;
                padding: 2px 0;
                cursor: pointer;
                text-decoration: underline;
              `;
              showOriginal.addEventListener('click', () => {
                if (this.showingOriginal) {
                  textElement.textContent = this.translatedText!;
                  showOriginal.textContent = 'Show original';
                } else {
                  textElement.textContent = this.originalText;
                  showOriginal.textContent = 'Show translation';
                }
                this.showingOriginal = !this.showingOriginal;
              });
              translateBar.appendChild(showOriginal);
            } else if (data.status === 'processing') {
              setTimeout(poll, 2000);
            } else {
              translateBtn.remove();
            }
          };
          setTimeout(poll, 2000);
        } catch {
          translateBtn.remove();
        }
      });

      translateBar.appendChild(translateBtn);
      this.postTextContainer.appendChild(translateBar);

      // Listen for locale changes
      const onLocaleChange = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail.locale !== authorLang) {
          translateBtn.textContent = `Translate to ${detail.locale.toUpperCase()}`;
        }
      };
      window.addEventListener('localechange', onLocaleChange);
    }

    container.appendChild(this.postTextContainer);

    if ('requestIdleCallback' in window) {
      window.requestIdleCallback?.(
        async () => {
          try {
            const richText = await createPostText({
              text: displayText,
              mentions: this.props.post.mentions,
              enablePostRefs: this.props.enablePostRefs,
            });
            textElement.replaceWith(richText);
          } catch (error) {
            console.error('Failed to create rich post text:', error);
          }
        },
        { timeout: 2000 },
      );
    } else {
      setTimeout(async () => {
        try {
          const richText = await createPostText({
            text: displayText,
            mentions: this.props.post.mentions,
            enablePostRefs: this.props.enablePostRefs,
          });
          textElement.replaceWith(richText);
        } catch (error) {
          console.error('Failed to create rich post text:', error);
        }
      }, 500);
    }

    // Tag chips (between text and PostStage)
    const hashtags = this.parseHashtags(this.props.post.hashtags);
    if (hashtags.length > 0) {
      const tagChips = this.createTagChips(hashtags);
      container.appendChild(tagChips);
    }

    // Poll section
    if (this.props.post.poll) {
      const pollEl = this.createPollElement({ ...this.props.post.poll, expired: false });
      container.appendChild(pollEl);
    }

    // Link Preview section (under text/poll/tags, above PostStage/Actions)
    const previewContainer = document.createElement('div');
    previewContainer.className = 'post-link-preview-container';
    previewContainer.style.cssText = 'overflow: hidden;';
    container.appendChild(previewContainer);
    loadLinkPreview(this.props.post.text, previewContainer);

    // Post stage (16:9 container for GIF/iframe/thumbnail) - only show if has attachments
    if (
      this.props.post.gif_key ||
      this.props.post.payload_key ||
      this.props.post.swf_key ||
      this.props.post.thumbnail_key
    ) {
      this.postStageElement = createPostStage({
        post: this.props.post,
        mode: this.mode,
        sandboxOrigin: this.props.sandboxOrigin,
        onModeChange: (newMode) => this.handleModeChange(newMode),
      });
      container.appendChild(this.postStageElement);
    }

    // Post actions (only if reply is not disabled)
    if (!this.props.disableReply) {
      const actions = createPostActions({
        postId: this.props.post.id,
        freshCount: this.freshCount,
        bookmarkCount: this.bookmarkCount,
        replyCount: this.replyCount,
        impressions: this.impressions,
        isFreshed: this.isFreshed,
        isBookmarked: this.isBookmarked,
        depth: this.props.depth ?? this.props.post.depth,
        onFreshToggle: () => this.handleFreshToggle(),
        onBookmarkToggle: () => this.handleBookmarkToggle(),
        onReplyToggle: () => this.handleReplyToggle(),
        onShare: () => this.handleShare(),
      });
      container.appendChild(actions);
    }

    // Reply composer (hidden by default, only if reply composer is not disabled)
    if (!this.props.disableReply && !this.props.disableReplyComposer) {
      const currentIndex = container.getAttribute('data-post-index');
      const prefill = currentIndex !== null ? `>>${currentIndex} ` : undefined;
      this.replyComposer = createReplyComposer({
        postId: this.props.post.id,
        sandboxOrigin: this.props.sandboxOrigin,
        onReplyCreated: (newReply) => this.handleReplyCreated(newReply as unknown as Record<string, unknown>),
        onCancel: () => this.hideReplyComposer(),
        prefillText: prefill,
        currentUser: this.props.currentUser || undefined,
      });
      this.replyComposer.getElement().style.display = 'none';
      container.appendChild(this.replyComposer.getElement());
    }

    return container;
  }

  private setupEventListeners(): void {
    // Setup sandbox bridge when iframe is available
    this.setupSandboxBridge();

    // Setup impression tracking using Intersection Observer
    this.setupImpressionTracking();

    // Add click handler for post navigation (but not for buttons/inputs or during text selection)
    if (!this.props.disableNavigation) {
      this.element.addEventListener('click', (e) => {
        console.log('PostCard clicked, target:', e.target);

        // Don't navigate if clicking on buttons, inputs, links, or poll options
        const target = e.target as HTMLElement;
        const closestButton = target.closest('button');
        const closestInput = target.closest('input');
        const closestTextarea = target.closest('textarea');
        const closestLink = target.closest('a');
        const closestPollOption = target.closest('.poll-option');

        // Check if text is being selected
        const selection = window.getSelection();
        const isSelectingText = selection && selection.toString().length > 0;

        console.log('Checking if should prevent navigation:', {
          closestButton,
          closestInput,
          closestTextarea,
          closestLink,
          closestPollOption,
          isSelectingText,
          selectedText: selection?.toString(),
        });

        if (closestButton || closestInput || closestTextarea || closestLink || closestPollOption || isSelectingText) {
          console.log('Navigation prevented - clicked on interactive element or text is being selected');
          return;
        }

        console.log('Navigating to thread for post:', this.props.post.id);
        // Navigate to thread page
        this.handlePostClick();
      });
    }
  }

  private setupSandboxBridge(): void {
    // Find the iframe in the post stage
    const iframe = this.element.querySelector('.sandbox-frame') as HTMLIFrameElement;

    if (iframe) {
      this.sandboxBridge = useSandboxBridge({
        iframe,
        post: this.props.post,
        onFreshRequest: () => this.handleFreshToggle(),
      });
    } else {
      // Iframe might not be ready yet, try again after a delay
      setTimeout(() => this.setupSandboxBridge(), 100);
    }
  }

  private setupImpressionTracking(): void {
    // Track impressions when post becomes visible in viewport
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            // Post is visible, track impression
            this.trackImpression();
            // Only track once per post view
            observer.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.5, // Track when 50% of post is visible
      },
    );

    observer.observe(this.element);
  }

  private trackImpression(): void {
    // Prevent duplicate tracking
    if (this.impressionTracked) return;

    this.impressionTracked = true;

    // Use global batch tracker
    impressionTracker.trackImpression(this.props.post.id);

    // Optimistically update impression count
    this.impressions += 1;
    this.updateActions();
  }

  private handleModeChange(newMode: PostCardMode): void {
    this.mode = newMode;
    if (this.postStageElement) {
      updatePostStage(this.postStageElement, {
        post: this.props.post,
        mode: this.mode,
        sandboxOrigin: this.props.sandboxOrigin,
        onModeChange: (newMode) => this.handleModeChange(newMode),
      });
    }
  }

  private async handleFreshToggle(): Promise<void> {
    // Prevent concurrent fresh requests
    if (this.freshLoading) return;

    // Check if user is logged in
    if (!this.props.currentUser) {
      showSignInPrompt(
        'fresh',
        () => {
          window.history.pushState({}, '', '/login');
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        () => {
          window.history.pushState({}, '', '/register');
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
      );
      return;
    }

    const previousFreshed = this.isFreshed;
    const previousCount = this.freshCount;

    // Optimistic update
    this.isFreshed = !previousFreshed;
    this.freshCount = previousFreshed ? previousCount - 1 : previousCount + 1;

    // Update UI immediately
    this.updateActions();

    this.freshLoading = true;

    try {
      const response = await fetch(`/api/posts/${this.props.post.id}/fresh`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to toggle fresh');
      }

      const result = (await response.json()) as { freshed: boolean; fresh_count: number };

      // Sync with server response (use authoritative fresh_count from server)
      this.isFreshed = result.freshed;
      this.freshCount = result.fresh_count;

      // Notify other components (e.g. cached timeline) about the fresh state change
      window.dispatchEvent(
        new CustomEvent('postUpdated', {
          detail: { postId: this.props.post.id, isFreshed: result.freshed, freshCount: result.fresh_count },
        }),
      );
    } catch (error) {
      // Rollback on error
      this.isFreshed = previousFreshed;
      this.freshCount = previousCount;
      console.error('Failed to toggle fresh:', error);
    } finally {
      this.freshLoading = false;
    }

    this.updateActions();
  }

  private async handleBookmarkToggle(): Promise<void> {
    if (this.bookmarkLoading) return;

    if (!this.props.currentUser) {
      showSignInPrompt(
        'bookmark',
        () => {
          window.history.pushState({}, '', '/login');
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        () => {
          window.history.pushState({}, '', '/register');
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
      );
      return;
    }

    const previousBookmarked = this.isBookmarked;
    const previousCount = this.bookmarkCount;

    this.isBookmarked = !previousBookmarked;
    this.bookmarkCount = previousBookmarked ? previousCount - 1 : previousCount + 1;

    this.updateActions();

    this.bookmarkLoading = true;

    try {
      const response = await fetch(`/api/posts/${this.props.post.id}/bookmark`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to toggle bookmark');
      }

      const result = (await response.json()) as { bookmarked: boolean; bookmark_count: number };

      this.isBookmarked = result.bookmarked;
      this.bookmarkCount = result.bookmark_count;

      window.dispatchEvent(
        new CustomEvent('postUpdated', {
          detail: { postId: this.props.post.id, isBookmarked: result.bookmarked, bookmarkCount: result.bookmark_count },
        }),
      );
    } catch (error) {
      this.isBookmarked = previousBookmarked;
      this.bookmarkCount = previousCount;
      console.error('Failed to toggle bookmark:', error);
    } finally {
      this.bookmarkLoading = false;
    }

    this.updateActions();
  }

  private handleReplyToggle(): void {
    // Check if user is logged in
    if (!this.props.currentUser) {
      showSignInPrompt(
        'reply',
        () => {
          window.history.pushState({}, '', '/login');
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        () => {
          window.history.pushState({}, '', '/register');
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
      );
      return;
    }

    // Emit custom event for thread view toggle (legacy, now handled inline)
    const event = new CustomEvent('replyToggle', {
      detail: { postId: this.props.post.id },
    });
    this.element.dispatchEvent(event);

    // Toggle inline reply composer
    this.toggleReplyComposer();
  }

  private toggleReplyComposer(): void {
    if (this.isReplyComposerOpen) {
      this.hideReplyComposer();
    } else {
      this.showReplyComposer();
    }
  }

  private showReplyComposer(): void {
    if (this.replyComposer) {
      this.replyComposer.getElement().style.display = 'block';
      this.isReplyComposerOpen = true;
      this.replyComposer.focus();
    }
  }

  private hideReplyComposer(): void {
    if (this.replyComposer) {
      this.replyComposer.getElement().style.display = 'none';
      this.isReplyComposerOpen = false;
    }
  }

  private handleReplyCreated(newReply: Record<string, unknown>): void {
    this.hideReplyComposer();
    this.replyCount++;
    this.updatePost({ reply_count: this.replyCount });
    this.updateActions();

    window.dispatchEvent(
      new CustomEvent('postUpdated', {
        detail: { postId: this.props.post.id, replyCount: this.replyCount, reply: newReply },
      }),
    );
  }

  public handleReplyTogglePublic(): void {
    this.handleReplyToggle();
  }

  private handleShare(): void {
    createShareModal({
      post: {
        id: this.props.post.id,
        text: this.props.post.text,
        username: this.props.post.username,
        display_name: this.props.post.display_name,
      },
      onClose: () => {},
    });
  }

  private handlePostClick(): void {
    if (window.location.pathname.startsWith('/thread/')) {
      return;
    }
    const threadUrl = `/thread/${this.props.post.id}`;
    if (window.location.pathname === threadUrl) {
      return;
    }

    // Navigate to thread page using SPA navigation
    console.log('Pushing state to URL:', threadUrl);
    window.history.pushState({ postId: this.props.post.id }, '', threadUrl);

    // Use SPA navigation event
    console.log('Dispatching SPA navigation event');
    window.dispatchEvent(
      new CustomEvent('spaNavigate', {
        detail: { view: 'thread', postId: this.props.post.id },
      }),
    );

    // Also emit custom event for navigation (backup)
    console.log('Emitting navigateToThread event');
    const customEvent = new CustomEvent('navigateToThread', {
      detail: { postId: this.props.post.id },
    });
    this.element.dispatchEvent(customEvent);
    console.log('Event dispatched');
  }

  private updateActions(): void {
    const actionsContainer = this.element.querySelector('.post-actions');
    if (actionsContainer) {
      const newActions = createPostActions({
        postId: this.props.post.id,
        freshCount: this.freshCount,
        bookmarkCount: this.bookmarkCount,
        replyCount: this.replyCount,
        impressions: this.impressions,
        isFreshed: this.isFreshed,
        isBookmarked: this.isBookmarked,
        depth: this.props.depth ?? this.props.post.depth,
        onFreshToggle: () => this.handleFreshToggle(),
        onBookmarkToggle: () => this.handleBookmarkToggle(),
        onReplyToggle: () => this.handleReplyToggle(),
        onShare: () => this.handleShare(),
      });
      actionsContainer.replaceWith(newActions);
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public getReplyCount(): number {
    return this.replyCount;
  }

  public updatePost(post: Partial<typeof this.props.post>): void {
    if (post.reply_count !== undefined) {
      this.replyCount = post.reply_count;
    }
    if (post.fresh_count !== undefined) {
      this.freshCount = post.fresh_count;
    }
    if (post.bookmark_count !== undefined) {
      this.bookmarkCount = post.bookmark_count;
    }
    if (post.is_freshed !== undefined) {
      this.isFreshed = post.is_freshed;
    }
    if (post.is_bookmarked !== undefined) {
      this.isBookmarked = post.is_bookmarked;
    }
    this.props.post = { ...this.props.post, ...post };
    this.updateActions();
  }

  private createMenuButton(isOwnPost: boolean): HTMLElement {
    const menuButton = document.createElement('button');
    menuButton.className = 'post-menu-button';
    menuButton.textContent = '⋯';
    menuButton.style.cssText = `
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      transition: color 0.2s ease;
    `;

    menuButton.addEventListener('mouseenter', () => {
      menuButton.style.color = 'var(--text-primary)';
    });
    menuButton.addEventListener('mouseleave', () => {
      menuButton.style.color = 'var(--text-muted)';
    });

    menuButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu(isOwnPost);
    });

    return menuButton;
  }

  private toggleMenu(isOwnPost: boolean): void {
    if (this.menuDropdown) {
      this.menuDropdown.remove();
      this.menuDropdown = undefined;
      return;
    }

    const dropdown = document.createElement('div');
    dropdown.className = 'post-menu-dropdown';
    dropdown.style.cssText = `
      position: absolute;
      top: 30px;
      right: 0;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      z-index: 100;
      min-width: 120px;
    `;

    if (isOwnPost) {
      if (this.props.post.hidden === 1) {
        const counterItem = document.createElement('button');
        counterItem.style.cssText = `
          display: block;
          width: 100%;
          padding: 10px 16px;
          background: none;
          border: none;
          color: var(--text-primary);
          text-align: left;
          cursor: pointer;
          font-size: 14px;
          transition: background 0.2s;
        `;
        counterItem.textContent = t('post.menu_counter_notice');
        counterItem.addEventListener('mouseenter', () => {
          counterItem.style.background = 'var(--bg-secondary)';
        });
        counterItem.addEventListener('mouseleave', () => {
          counterItem.style.background = 'none';
        });
        counterItem.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.remove();
          this.menuDropdown = undefined;
          this.showCounterNoticeModal();
        });
        dropdown.appendChild(counterItem);
      }

      const editItem = document.createElement('button');
      editItem.style.cssText = `
        display: block;
        width: 100%;
        padding: 10px 16px;
        background: none;
        border: none;
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.2s;
      `;
      editItem.textContent = t('post.menu_edit');
      editItem.addEventListener('mouseenter', () => {
        editItem.style.background = 'var(--bg-secondary)';
      });
      editItem.addEventListener('mouseleave', () => {
        editItem.style.background = 'none';
      });
      editItem.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.remove();
        this.menuDropdown = undefined;
        this.startEditing();
      });
      dropdown.appendChild(editItem);

      const deleteItem = document.createElement('button');
      deleteItem.style.cssText = `
        display: block;
        width: 100%;
        padding: 10px 16px;
        background: none;
        border: none;
        color: var(--danger, #e74c3c);
        text-align: left;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.2s;
      `;
      deleteItem.textContent = t('post.menu_delete');
      deleteItem.addEventListener('mouseenter', () => {
        deleteItem.style.background = 'var(--bg-secondary)';
      });
      deleteItem.addEventListener('mouseleave', () => {
        deleteItem.style.background = 'none';
      });
      deleteItem.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showDeleteConfirmation();
        dropdown.remove();
        this.menuDropdown = undefined;
      });
      dropdown.appendChild(deleteItem);
    } else {
      const reportItem = document.createElement('button');
      reportItem.style.cssText = `
        display: block;
        width: 100%;
        padding: 10px 16px;
        background: none;
        border: none;
        color: var(--text-primary);
        text-align: left;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.2s;
      `;
      reportItem.textContent = t('post.menu_report');
      reportItem.addEventListener('mouseenter', () => {
        reportItem.style.background = 'var(--bg-secondary)';
      });
      reportItem.addEventListener('mouseleave', () => {
        reportItem.style.background = 'none';
      });
      reportItem.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.remove();
        this.menuDropdown = undefined;
        // Check if user is logged in before showing report modal
        if (!this.props.currentUser) {
          showSignInPrompt(
            'report',
            () => {
              window.history.pushState({}, '', '/login');
              window.dispatchEvent(new PopStateEvent('popstate'));
            },
            () => {
              window.history.pushState({}, '', '/register');
              window.dispatchEvent(new PopStateEvent('popstate'));
            },
          );
          return;
        }
        this.showReportModal();
      });
      dropdown.appendChild(reportItem);
    }

    const headerContainer = this.element.querySelector('.post-menu-button')?.parentElement;
    if (headerContainer) {
      headerContainer.style.position = 'relative';
      headerContainer.appendChild(dropdown);
    }

    this.menuDropdown = dropdown;

    const closeMenu = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.remove();
        this.menuDropdown = undefined;
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
  }

  private showDeleteConfirmation(): void {
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      max-width: 400px;
      width: 90%;
    `;

    const title = document.createElement('h3');
    title.style.cssText = 'margin: 0 0 16px 0; font-size: 18px; color: var(--text-primary);';
    title.textContent = t('post.delete_title');

    const message = document.createElement('p');
    message.style.cssText = 'margin: 0 0 24px 0; color: var(--text-muted); font-size: 14px;';
    message.textContent = t('post.delete_message');

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel-btn';
    cancelBtn.style.cssText =
      'padding: 8px 16px; background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); cursor: pointer;';
    cancelBtn.textContent = t('common.cancel');

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.style.cssText =
      'padding: 8px 16px; background: var(--danger, #e74c3c); border: none; border-radius: 4px; color: #fff; cursor: pointer;';
    deleteBtn.textContent = t('common.delete');

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(deleteBtn);

    dialog.appendChild(title);
    dialog.appendChild(message);
    dialog.appendChild(buttonRow);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    cancelBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });

    deleteBtn.addEventListener('click', async () => {
      unregister();
      overlay.remove();
      await this.deletePost();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });
  }

  private async deletePost(): Promise<void> {
    try {
      const response = await fetch(`/api/posts/${this.props.post.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to delete post');
      }

      this.props.onDelete?.(this.props.post.id);

      this.element.style.transition = 'opacity 0.3s, transform 0.3s';
      this.element.style.opacity = '0';
      this.element.style.transform = 'translateX(-100%)';
      setTimeout(() => {
        this.destroy();
      }, 300);

      this.showToast(t('post.deleted'));
    } catch (error) {
      console.error('Delete post error:', error);
      this.showToast(t('post.delete_failed'), true);
    }
  }

  private showReportModal(): void {
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.className = 'report-modal-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      max-width: 420px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    `;

    const categories = [
      { value: 'spam', label: t('post.report_category_spam') },
      { value: 'harassment', label: t('post.report_category_harassment') },
      { value: 'hate_speech', label: t('post.report_category_hate_speech') },
      { value: 'inappropriate', label: t('post.report_category_inappropriate') },
      { value: 'misinformation', label: t('post.report_category_misinformation') },
      { value: 'privacy', label: t('post.report_category_privacy') },
      { value: 'copyright', label: t('post.report_category_copyright') },
      { value: 'malware', label: t('post.report_category_malware') },
      { value: 'csam', label: t('post.report_category_csam') },
      { value: 'other', label: t('post.report_category_other') },
    ];

    dialog.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">${t('post.report_title')}</h3>
        <button class="close-btn" style="
          background: none;
          border: none;
          color: var(--text-muted);
          font-size: 20px;
          cursor: pointer;
        ">✕</button>
      </div>
      <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 14px;">${t('post.report_question')}</p>
      <div class="categories" style="margin-bottom: 24px;">
        ${categories
          .map(
            (c) => `
          <label style="
            display: flex;
            align-items: center;
            padding: 10px 0;
            cursor: pointer;
            color: var(--text-primary);
          ">
            <input type="radio" name="report-category" value="${c.value}" style="margin-right: 12px;">
            <span>${c.label}</span>
          </label>
        `,
          )
          .join('')}
      </div>
      <div class="dmca-section" style="display: none; margin-bottom: 24px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;">
        <h4 style="margin: 0 0 12px 0; font-size: 14px; color: var(--text-primary);">${t('post.report_dmca_title')}</h4>
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_work_label')}</label>
          <input type="text" class="dmca-work" style="
            width: 100%;
            padding: 8px;
            border: 1px solid var(--border);
            border-radius: 4px;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-size: 14px;
            box-sizing: border-box;
          " placeholder="${t('post.report_dmca_work_placeholder')}">
        </div>
        <div style="margin-bottom: 12px;">
          <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_email_label')}</label>
          <input type="email" class="dmca-email" style="
            width: 100%;
            padding: 8px;
            border: 1px solid var(--border);
            border-radius: 4px;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-size: 14px;
            box-sizing: border-box;
          " placeholder="${t('post.report_dmca_email_placeholder')}">
        </div>
        <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
          <input type="checkbox" class="dmca-sworn" style="margin-top: 2px;">
          <span style="font-size: 12px; color: var(--text-muted);">${t('post.report_dmca_swear')}</span>
        </label>
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button class="submit-btn" disabled style="
          padding: 10px 24px;
          background: var(--accent);
          border: none;
          border-radius: 9999px;
          color: #000;
          font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          cursor: pointer;
          opacity: 0.5;
        ">${t('common.submit')}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const submitBtn = dialog.querySelector('.submit-btn') as HTMLButtonElement;
    const closeBtn = dialog.querySelector('.close-btn');
    const radioInputs = dialog.querySelectorAll('input[name="report-category"]');
    const dmcaSection = dialog.querySelector('.dmca-section') as HTMLElement;
    const dmcaWorkInput = dialog.querySelector('.dmca-work') as HTMLInputElement;
    const dmcaEmailInput = dialog.querySelector('.dmca-email') as HTMLInputElement;
    const dmcaSwornCheckbox = dialog.querySelector('.dmca-sworn') as HTMLInputElement;

    let selectedCategory: string | null = null;

    radioInputs.forEach((input) => {
      input.addEventListener('change', (e) => {
        selectedCategory = (e.target as HTMLInputElement).value;
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';

        // Show/hide DMCA section
        if (selectedCategory === 'copyright') {
          dmcaSection.style.display = 'block';
        } else {
          dmcaSection.style.display = 'none';
        }
      });
    });

    const checkSubmitEnabled = () => {
      if (!selectedCategory) {
        return false;
      }
      if (selectedCategory === 'copyright') {
        const workDescription = dmcaWorkInput.value.trim();
        const email = dmcaEmailInput.value.trim();
        const sworn = dmcaSwornCheckbox.checked;
        return workDescription.length > 0 && email.length > 0 && sworn;
      }
      return true;
    };

    dmcaWorkInput?.addEventListener('input', () => {
      submitBtn.disabled = !checkSubmitEnabled();
      submitBtn.style.opacity = checkSubmitEnabled() ? '1' : '0.5';
    });

    dmcaEmailInput?.addEventListener('input', () => {
      submitBtn.disabled = !checkSubmitEnabled();
      submitBtn.style.opacity = checkSubmitEnabled() ? '1' : '0.5';
    });

    dmcaSwornCheckbox?.addEventListener('change', () => {
      submitBtn.disabled = !checkSubmitEnabled();
      submitBtn.style.opacity = checkSubmitEnabled() ? '1' : '0.5';
    });

    closeBtn?.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });

    submitBtn?.addEventListener('click', async () => {
      if (!selectedCategory) return;

      let dmcaData: { work_description: string; reporter_email: string; sworn: boolean } | undefined;
      if (selectedCategory === 'copyright') {
        dmcaData = {
          work_description: dmcaWorkInput.value.trim(),
          reporter_email: dmcaEmailInput.value.trim(),
          sworn: dmcaSwornCheckbox.checked,
        };
      }

      unregister();
      overlay.remove();
      await this.submitReport(selectedCategory, dmcaData);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });
  }

  private async submitReport(
    category: string,
    dmcaData?: { work_description: string; reporter_email: string; sworn: boolean },
  ): Promise<void> {
    try {
      const body: {
        post_id: string;
        category: string;
        dmca?: { work_description: string; reporter_email: string; sworn: boolean };
      } = { post_id: this.props.post.id, category };
      if (dmcaData) {
        body.dmca = dmcaData;
      }

      const response = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (response.status === 409) {
        this.showToast(t('post.report_already'));
        return;
      }

      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData?.error || 'Failed to submit report');
      }

      this.showToast(t('post.report_submitted'));
    } catch (error) {
      console.error('Report error:', error);
      console.error('Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        post_id: this.props.post.id,
        category: category || 'unknown',
      });
      this.showToast(t('post.report_failed'), true);
    }
  }

  private showCounterNoticeModal(): void {
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.className = 'counter-notice-modal-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      max-width: 520px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    `;

    dialog.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0; font-size: 18px; color: var(--text-primary);">${t('post.counter_notice_title')}</h3>
        <button class="close-btn" style="
          background: none;
          border: none;
          color: var(--text-muted);
          font-size: 20px;
          cursor: pointer;
        ">✕</button>
      </div>
      <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 14px;">${t('post.counter_notice_explanation')}</p>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_name_label')}</label>
        <input type="text" class="cn-name" style="
          width: 100%; padding: 8px; border: 1px solid var(--border);
          border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);
          font-size: 14px; box-sizing: border-box;
        " placeholder="${t('post.counter_notice_name_placeholder')}">
      </div>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_email_label')}</label>
        <input type="email" class="cn-email" style="
          width: 100%; padding: 8px; border: 1px solid var(--border);
          border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);
          font-size: 14px; box-sizing: border-box;
        " placeholder="${t('post.counter_notice_email_placeholder')}">
      </div>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_address_label')}</label>
        <input type="text" class="cn-address" style="
          width: 100%; padding: 8px; border: 1px solid var(--border);
          border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);
          font-size: 14px; box-sizing: border-box;
        " placeholder="${t('post.counter_notice_address_placeholder')}">
      </div>
      <div style="margin-bottom: 16px;">
        <label style="display: block; margin-bottom: 4px; font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_phone_label')}</label>
        <input type="tel" class="cn-phone" style="
          width: 100%; padding: 8px; border: 1px solid var(--border);
          border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);
          font-size: 14px; box-sizing: border-box;
        " placeholder="${t('post.counter_notice_phone_placeholder')}">
      </div>
      <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; cursor: pointer;">
        <input type="checkbox" class="cn-statement" style="margin-top: 2px;">
        <span style="font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_statement')}</span>
      </label>
      <label style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 16px; cursor: pointer;">
        <input type="checkbox" class="cn-consent" style="margin-top: 2px;">
        <span style="font-size: 12px; color: var(--text-muted);">${t('post.counter_notice_consent')}</span>
      </label>
      <div style="display: flex; justify-content: flex-end;">
        <button class="submit-btn" disabled style="
          padding: 10px 24px; background: var(--accent); border: none;
          border-radius: 9999px; color: #000;
          font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px; cursor: pointer; opacity: 0.5;
        ">${t('common.submit')}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const submitBtn = dialog.querySelector('.submit-btn') as HTMLButtonElement;
    const closeBtn = dialog.querySelector('.close-btn');
    const nameInput = dialog.querySelector('.cn-name') as HTMLInputElement;
    const emailInput = dialog.querySelector('.cn-email') as HTMLInputElement;
    const addressInput = dialog.querySelector('.cn-address') as HTMLInputElement;
    const phoneInput = dialog.querySelector('.cn-phone') as HTMLInputElement;
    const statementCheckbox = dialog.querySelector('.cn-statement') as HTMLInputElement;
    const consentCheckbox = dialog.querySelector('.cn-consent') as HTMLInputElement;

    const checkEnabled = () => {
      const valid =
        nameInput.value.trim().length > 0 &&
        emailInput.value.trim().length > 0 &&
        addressInput.value.trim().length > 0 &&
        phoneInput.value.trim().length > 0 &&
        statementCheckbox.checked &&
        consentCheckbox.checked;
      submitBtn.disabled = !valid;
      submitBtn.style.opacity = valid ? '1' : '0.5';
    };

    [nameInput, emailInput, addressInput, phoneInput].forEach((el) => {
      el.addEventListener('input', checkEnabled);
    });
    statementCheckbox.addEventListener('change', checkEnabled);
    consentCheckbox.addEventListener('change', checkEnabled);

    closeBtn?.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });

    submitBtn?.addEventListener('click', async () => {
      unregister();
      overlay.remove();
      await this.submitCounterNotice({
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        address: addressInput.value.trim(),
        phone: phoneInput.value.trim(),
        statement: statementCheckbox.checked,
        consent_jurisdiction: consentCheckbox.checked,
      });
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });
  }

  private async submitCounterNotice(data: {
    name: string;
    email: string;
    address: string;
    phone: string;
    statement: boolean;
    consent_jurisdiction: boolean;
  }): Promise<void> {
    try {
      const response = await fetch(`/api/posts/${this.props.post.id}/counter-notice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });

      if (response.status === 409) {
        this.showToast(t('post.counter_notice_already'));
        return;
      }

      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData?.error || 'Failed to submit counter-notice');
      }

      this.showToast(t('post.counter_notice_submitted'));
    } catch (error) {
      console.error('Counter-notice error:', error);
      this.showToast(t('post.counter_notice_failed'), true);
    }
  }

  private showToast(message: string, isError: boolean = false): void {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: ${isError ? 'var(--danger, #e74c3c)' : 'var(--accent)'};
      color: ${isError ? '#fff' : '#000'};
      padding: 12px 24px;
      border-radius: 4px;
      font-size: 14px;
      z-index: 2000;
      animation: fadeInUp 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'fadeOut 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  public destroy(): void {
    // Cleanup sandbox bridge
    if (this.sandboxBridge) {
      this.sandboxBridge.destroy();
      this.sandboxBridge = undefined;
    }

    // Cleanup reply composer
    if (this.replyComposer) {
      this.replyComposer.destroy();
      this.replyComposer = undefined;
    }

    // Cleanup menu dropdown
    if (this.menuDropdown) {
      this.menuDropdown.remove();
      this.menuDropdown = undefined;
    }

    // Cleanup event listeners
    this.element.remove();
  }

  private parseHashtags(hashtagsString: string): string[] {
    try {
      const parsed = JSON.parse(hashtagsString);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private createTagChips(hashtags: string[]): HTMLElement {
    const container = document.createElement('div');
    container.className = 'post-tag-chips';
    container.style.cssText = `
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 12px 0;
    `;

    hashtags.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'post-tag-chip';
      chip.textContent = `#${tag}`;
      chip.style.cssText = `
        display: inline-block;
        padding: 4px 12px;
        background: var(--bg-secondary);
        color: var(--accent);
        font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        border-radius: 9999px;
        cursor: pointer;
        transition: all 0.2s ease;
      `;

      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.history.pushState({}, '', `/explore?tag=${encodeURIComponent(tag)}`);
        window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore', tag } }));
      });

      chip.addEventListener('mouseenter', () => {
        chip.style.background = 'var(--accent)';
        chip.style.color = '#000';
      });

      chip.addEventListener('mouseleave', () => {
        chip.style.background = 'var(--bg-secondary)';
        chip.style.color = 'var(--accent)';
      });

      container.appendChild(chip);
    });

    return container;
  }

  private createPollElement(poll: {
    id: string;
    question: string;
    userVote: string | null;
    expired: boolean;
    multipleChoice: boolean;
    endsAt?: string | null;
    options: Array<{ id: string; label: string; votes_count: number }>;
  }): HTMLElement {
    const totalVotes = poll.options.reduce(
      (sum: number, opt: { id: string; label: string; votes_count: number }) => sum + Number(opt.votes_count || 0),
      0,
    );
    const hasVoted = !!poll.userVote;
    const isExpired = poll.expired;
    const showResults = hasVoted || isExpired;
    const canChangeVote = hasVoted && !isExpired;

    const container = document.createElement('div');
    container.className = 'post-poll';
    container.style.cssText = `margin: 12px 0; padding: 12px; background: var(--bg-secondary); border-radius: 8px;`;

    const question = document.createElement('div');
    question.className = 'poll-question';
    question.style.cssText = `font-weight: 600; margin-bottom: 8px; color: var(--text-primary);`;
    question.textContent = poll.question;
    container.appendChild(question);

    if (isExpired) {
      const endedBadge = document.createElement('div');
      endedBadge.style.cssText = `font-size: 0.75rem; color: var(--text-muted); margin-bottom: 6px;`;
      endedBadge.textContent = t('poll.ended');
      container.appendChild(endedBadge);
    }

    poll.options.forEach((opt: { id: string; label: string; votes_count: number }) => {
      const optEl = document.createElement('div');
      optEl.className = 'poll-option';
      const pct = totalVotes > 0 ? Math.round((opt.votes_count / totalVotes) * 100) : 0;
      const isOwnVote = opt.id === poll.userVote;
      const clickable = !isExpired && !isOwnVote;
      optEl.style.cssText = `
        position: relative; padding: 8px 12px; margin-bottom: 6px; border-radius: 6px;
        cursor: ${clickable ? 'pointer' : 'default'};
        background: var(--bg-primary); overflow: hidden;
        transition: opacity 0.2s; border: 1px solid var(--border);
        ${showResults || opt.votes_count > 0 ? '' : 'opacity: 0.9;'}
        ${isOwnVote ? 'border-color: var(--accent);' : ''}
      `;

      const bar = document.createElement('div');
      bar.className = 'poll-bar';
      bar.style.cssText = `
        position: absolute; top: 0; left: 0; height: 100%; 
        background: var(--accent);
        width: ${showResults ? pct : 0}%; transition: width 0.5s ease; border-radius: 5px;
        opacity: 0.25;
      `;
      optEl.appendChild(bar);

      const label = document.createElement('span');
      label.className = 'poll-option-label';
      label.style.cssText = `position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: center;`;
      const textSpan = document.createElement('span');
      textSpan.textContent = opt.label;
      const countSpan = document.createElement('span');
      countSpan.style.cssText = `font-size: 0.8rem; color: var(--text-muted); margin-left: 8px;`;
      countSpan.textContent = showResults ? `${pct}%` : '';
      label.appendChild(textSpan);
      label.appendChild(countSpan);
      optEl.appendChild(label);

      if (clickable) {
        optEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const response = await fetch(`/api/polls/${poll.id}/vote`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ optionId: opt.id }),
            });
            if (response.status === 409) {
              return;
            }
            if (!response.ok) {
              const errBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
              if (errBody?.error) console.error(t('poll.vote_error'), errBody.error);
              return;
            }
            const data = (await response.json()) as {
              options: Array<{ id: string; label: string; votes_count: number }>;
              userVote: string | null;
            };
            const newPoll = { ...poll, options: data.options, userVote: data.userVote };
            container.replaceWith(this.createPollElement(newPoll));
          } catch (e) {
            console.error('Vote failed:', e);
          }
        });
        optEl.addEventListener('mouseenter', () => {
          optEl.style.borderColor = 'var(--accent)';
        });
        optEl.addEventListener('mouseleave', () => {
          optEl.style.borderColor = 'var(--border)';
        });
      }
      container.appendChild(optEl);
    });

    const footer = document.createElement('div');
    footer.style.cssText = `font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;`;

    const voteText =
      totalVotes === 1
        ? t('poll.votes', { count: formatCount(totalVotes) })
        : t('poll.votes_plural', { count: formatCount(totalVotes) });
    const votedText = hasVoted ? ` · ${t('poll.voted')}` : '';
    const changeHint = canChangeVote ? ` · ${t('poll.click_to_change')}` : '';
    let timeText = '';
    if (poll.endsAt && !isExpired) {
      const remaining = this.formatRemainingTime(poll.endsAt);
      timeText = ` · ${t('poll.remaining', { time: remaining })}`;
    }

    footer.textContent = `${voteText}${votedText}${changeHint}${timeText}`;
    container.appendChild(footer);

    return container;
  }

  private formatRemainingTime(endsAt: string): string {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return t('poll.ended');
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(hours / 24);
    const minutes = Math.floor((diff % 3600000) / 60000);
    if (days > 0) return t('poll.remaining_days', { count: days });
    if (hours > 0) return t('poll.remaining_hours', { count: hours });
    if (minutes > 0) return t('poll.remaining_minutes', { count: minutes });
    return t('poll.remaining_less_minute');
  }

  private startEditing(): void {
    if (this.isEditing || !this.postTextContainer) return;
    this.isEditing = true;

    const textElement = this.postTextContainer.querySelector('.post-text');
    if (!textElement) return;

    const currentText = this.originalText;

    this.editContainer = document.createElement('div');
    this.editContainer.style.cssText = 'margin-bottom: 1rem;';

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = currentText;
    textarea.maxLength = 200;
    textarea.style.cssText = `
      width: 100%;
      min-height: 60px;
      padding: 8px;
      font-size: 0.9rem;
      font-family: inherit;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      resize: vertical;
      outline: none;
      box-sizing: border-box;
    `;

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = `
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
      margin-top: 0.5rem;
    `;

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = t('post.edit_cancel');
    cancelBtn.style.cssText = `
      padding: 6px 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-secondary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.85rem;
    `;

    const saveBtn = document.createElement('button');
    saveBtn.textContent = t('post.edit_save');
    saveBtn.style.cssText = `
      padding: 6px 16px;
      border: none;
      border-radius: 6px;
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 600;
    `;

    let saving = false;
    saveBtn.addEventListener('click', async () => {
      if (saving) return;
      const newText = textarea.value.trim();
      if (!newText || newText === currentText) {
        this.cancelEdit();
        return;
      }
      saving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = '...';
      try {
        const res = await fetch(`/api/posts/${this.props.post.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ text: newText }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string })?.error || 'Edit failed');
        }
        const data = (await res.json()) as { text: string; edited_at: string };
        this.originalText = data.text;
        this.props.post.text = data.text;
        this.props.post.edited_at = data.edited_at;
        this.cancelEdit();
        this.showToast(t('post.edit_saved'));
      } catch (err) {
        this.showToast(t('post.edit_failed'), true);
      } finally {
        saving = false;
        saveBtn.disabled = false;
        saveBtn.textContent = t('post.edit_save');
      }
    });

    cancelBtn.addEventListener('click', () => this.cancelEdit());

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.cancelEdit();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveBtn.click();
    });

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(saveBtn);
    this.editContainer.appendChild(textarea);
    this.editContainer.appendChild(buttonRow);

    textElement.replaceWith(this.editContainer);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  private cancelEdit(): void {
    if (!this.isEditing || !this.editContainer || !this.postTextContainer) return;
    this.isEditing = false;

    const textElement = document.createElement('div');
    textElement.className = 'post-text';
    textElement.style.cssText = `
      line-height: 1.6;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
    `;
    textElement.textContent = this.originalText;

    this.editContainer.replaceWith(textElement);
    this.editContainer = null;
  }
}

// Factory function for easier usage
export function createPostCard(props: PostCardProps): PostCard {
  return new PostCard(props);
}
