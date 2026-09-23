import { t } from '../lib/i18n.js';
import { impressionTracker } from '../lib/impression-tracker.js';
import { loadLinkPreview } from '../lib/link-preview.js';
import { createModalOverlay } from '../lib/modal-overlay.js';
import { openPostModal } from '../lib/post-modal.js';
import { useSandboxBridge } from '../lib/sandbox-bridge.js';
import { getShowNsfw } from '../lib/settings.js';
import { showToast } from '../lib/toast.js';
import { PostCardMode, type PostCardProps, type QuotedPost, type ReactionSummary } from '../types/post.js';
import { openCounterNoticeModal } from './CounterNoticeModal.js';
import { openGameUpdateModal } from './GameUpdateModal.js';
import { createPollElement } from './PollWidget.js';
import { createPostActions } from './PostActions.js';
import { createPostHeader } from './PostHeader.js';
import { createMenuButton, createPostMenuDropdown, setupMenuCloseHandler } from './PostMenu.js';
import { createPostStage, updatePostStage } from './PostStage.js';
import { createPostText } from './PostText.js';
import { createQuotedPostCard } from './QuotedPostCard.js';
import { createReplyComposer, ReplyComposer } from './ReplyComposer.js';
import { openReportModal } from './ReportModal.js';
import { createShareModal } from './ShareModal.js';
import { showSignInPrompt } from './SignInPrompt.js';
import { openVersionHistoryModal } from './VersionHistoryModal.js';

// How many 100ms attempts to make before giving up on attaching the sandbox
// bridge. The iframe is created synchronously once a post starts executing, so
// a small cap is enough to catch it without piling up dead timers.
const MAX_SANDBOX_BRIDGE_RETRIES = 20;

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
  private reactions: ReactionSummary[];
  private impressionTracked: boolean = false;
  private postStageElement?: HTMLElement;
  private sandboxBridge?: ReturnType<typeof useSandboxBridge>;
  private sandboxBridgeTimer?: ReturnType<typeof setTimeout>;
  private sandboxBridgeRetries: number = 0;
  private replyComposer?: ReplyComposer;
  private isReplyComposerOpen: boolean = false;
  private menuDropdown?: HTMLElement;
  private onPinChanged?: (e: Event) => void;
  private freshLoading: boolean = false;
  private bookmarkLoading: boolean = false;
  private originalText: string;
  private isEditing: boolean = false;
  private editContainer: HTMLElement | null = null;
  private postTextContainer: HTMLElement | null = null;
  private editAttachmentFile: File | null = null;
  private editNewAttachmentKey: string | null = null;
  private editRemoveAttachment: boolean = false;
  private currentVersionId: string | null = null;
  private impressionObserver?: IntersectionObserver;

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
    this.reactions = props.post.reactions || [];
    this.element = this.createElement();
    this.setupEventListeners();

    if (this.props.showPinOption) {
      this.onPinChanged = (e: Event) => {
        const detail = (e as CustomEvent<{ pinnedId: string | null }>).detail;
        this.props.pinned = detail?.pinnedId === this.props.post.id;
      };
      window.addEventListener('profilePinChanged', this.onPinChanged);
    }
  }

  private createElement(): HTMLElement {
    // If NSFW and not opted-in, hide the post entirely
    const nsfwTags = this.parseHashtags(this.props.post.hashtags);
    const isNsfw = nsfwTags.some((tag) => tag.toLowerCase() === 'nsfw' || tag.toLowerCase() === 'r18');
    if (isNsfw && !getShowNsfw()) {
      const hidden = document.createElement('div');
      hidden.style.display = 'none';
      return hidden;
    }

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
      badge_type: this.props.post.badge_type,
      createdAt: this.props.post.created_at,
      editedAt: this.props.post.edited_at,
    });
    headerContainer.appendChild(header);

    // ... menu button
    const isOwnPost = this.props.currentUser?.username === this.props.post.username;
    const menuButton = createMenuButton(() => this.toggleMenu(isOwnPost));
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

    container.appendChild(this.postTextContainer);

    if ('requestIdleCallback' in window) {
      window.requestIdleCallback?.(
        async () => {
          try {
            const richText = await createPostText({
              text: displayText,
              mentions: this.props.post.mentions,
              enablePostRefs: this.props.enablePostRefs,
              authorId: this.props.post.user_id,
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
            authorId: this.props.post.user_id,
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
      const pollEl = createPollElement({ ...this.props.post.poll, expired: false });
      container.appendChild(pollEl);
    }

    // Link Preview section (under text/poll/tags, above PostStage/Actions)
    const previewContainer = document.createElement('div');
    previewContainer.className = 'post-link-preview-container';
    previewContainer.style.cssText = 'overflow: hidden;';
    container.appendChild(previewContainer);
    loadLinkPreview(this.props.post.text, previewContainer);

    // Quoted post card
    if (this.props.post.quoted_post_id) {
      const quotedCard = createQuotedPostCard({
        quoted: this.props.post.quoted_post ?? null,
        disableNavigation: this.props.disableNavigation,
        onNavigateToThread: (postId) => this.navigateToThread(postId),
      });
      if (quotedCard) container.appendChild(quotedCard);
    }

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
        versionId: this.currentVersionId ?? undefined,
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
        reactions: this.reactions,
        depth: this.props.depth ?? this.props.post.depth,
        onFreshToggle: () => this.handleFreshToggle(),
        onBookmarkToggle: () => this.handleBookmarkToggle(),
        onReplyToggle: () => this.handleReplyToggle(),
        onShare: () => this.handleShare(),
        onQuote: () => this.handleQuote(),
        onReactionToggle: (emoji) => this.handleReactionToggle(emoji),
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

    // NSFW blur overlay (only when opted-in via settings)
    if (isNsfw && getShowNsfw()) {
      container.style.position = 'relative';
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.45);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 5;
        border-radius: 8px;
      `;

      const warning = document.createElement('div');
      warning.style.cssText = 'text-align: center; padding: 1rem;';

      const icon = document.createElement('div');
      icon.textContent = '⚠️';
      icon.style.cssText = 'font-size: 1.5rem; margin-bottom: 6px;';

      const warningText = document.createElement('p');
      warningText.textContent = t('post.nsfw_warning');
      warningText.style.cssText = `
        color: var(--text-muted);
        font-size: 0.8125rem;
        margin: 0 0 10px 0;
      `;

      const showButton = document.createElement('button');
      showButton.textContent = t('post.nsfw_show');
      showButton.style.cssText = `
        padding: 6px 14px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg-primary);
        color: var(--text-primary);
        cursor: pointer;
        font-size: 0.8rem;
        transition: background 0.2s;
      `;
      showButton.addEventListener('mouseenter', () => {
        showButton.style.background = 'var(--bg-secondary)';
      });
      showButton.addEventListener('mouseleave', () => {
        showButton.style.background = 'var(--bg-primary)';
      });
      showButton.addEventListener('click', (e) => {
        e.stopPropagation();
        overlay.remove();
      });

      warning.appendChild(icon);
      warning.appendChild(warningText);
      warning.appendChild(showButton);
      overlay.appendChild(warning);
      container.appendChild(overlay);
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
        // Don't navigate if clicking on buttons, inputs, links, or poll options
        const target = e.target as HTMLElement;
        const closestButton = target.closest('button');
        const closestInput = target.closest('input');
        const closestTextarea = target.closest('textarea');
        const closestLink = target.closest('a');
        const closestPollOption = target.closest('.poll-option');
        const closestMediaPlayer = target.closest('.video-player, .audio-player, .image-preview');

        // Check if text is being selected
        const selection = window.getSelection();
        const isSelectingText = selection && selection.toString().length > 0;

        if (
          closestButton ||
          closestInput ||
          closestTextarea ||
          closestLink ||
          closestPollOption ||
          closestMediaPlayer ||
          isSelectingText
        ) {
          return;
        }

        // Navigate to thread page
        this.handlePostClick();
      });
    }
  }

  private setupSandboxBridge(): void {
    // Find the iframe in the post stage
    const iframe = this.element.querySelector('.sandbox-frame') as HTMLIFrameElement;

    if (iframe) {
      if (this.sandboxBridgeTimer) {
        clearTimeout(this.sandboxBridgeTimer);
        this.sandboxBridgeTimer = undefined;
      }
      this.sandboxBridge = useSandboxBridge({
        iframe,
        post: this.props.post,
        onFreshRequest: () => this.handleFreshToggle(),
      });
      return;
    }

    // The sandbox iframe only exists while a post is executing, so it can never
    // appear in PREVIEW mode. Retrying there would run a 100ms timer forever per
    // card, keeping dead cards (and their closures) alive — so retry only in
    // EXECUTING mode and only for a bounded number of times.
    if (this.mode !== PostCardMode.EXECUTING || this.sandboxBridgeRetries >= MAX_SANDBOX_BRIDGE_RETRIES) {
      return;
    }
    this.sandboxBridgeRetries += 1;
    if (this.sandboxBridgeTimer) {
      clearTimeout(this.sandboxBridgeTimer);
    }
    this.sandboxBridgeTimer = setTimeout(() => {
      this.sandboxBridgeTimer = undefined;
      this.setupSandboxBridge();
    }, 100);
  }

  private setupImpressionTracking(): void {
    // Track impressions when post becomes visible in viewport
    this.impressionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            // Post is visible, track impression
            this.trackImpression();
            // Only track once per post view
            this.impressionObserver?.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.5, // Track when 50% of post is visible
      },
    );

    this.impressionObserver.observe(this.element);
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

  private async handleModeChange(newMode: PostCardMode): Promise<void> {
    this.mode = newMode;
    // The sandbox iframe only appears once the post starts executing, so begin
    // (re)binding the bridge when we switch into EXECUTING mode.
    if (newMode === PostCardMode.EXECUTING && !this.sandboxBridge) {
      this.sandboxBridgeRetries = 0;
      this.setupSandboxBridge();
    }
    // When entering EXECUTING mode without an explicit version, resolve the
    // latest versionId so the sandbox always receives ?v=<latest>.
    if (newMode === PostCardMode.EXECUTING && this.currentVersionId === null) {
      try {
        const res = await fetch(`/api/posts/${this.props.post.id}/versions`);
        if (res.ok) {
          const data = (await res.json()) as {
            versions: Array<{ id: string; versionNumber: number }>;
          };
          const versions = data.versions;
          if (versions.length > 0) {
            versions.sort((a, b) => b.versionNumber - a.versionNumber);
            this.currentVersionId = versions[0].id;
          }
        }
      } catch {
        // proceed without version resolution
      }
    }
    if (this.postStageElement) {
      updatePostStage(this.postStageElement, {
        post: this.props.post,
        mode: this.mode,
        sandboxOrigin: this.props.sandboxOrigin,
        versionId: this.currentVersionId ?? undefined,
        onModeChange: (newMode) => this.handleModeChange(newMode),
      });
    }
  }

  // Switch the executed game to a specific archived version (or back to the
  // latest by passing null) and (re)load the sandbox iframe.
  private playVersion(versionId: string | null): void {
    this.currentVersionId = versionId;
    this.mode = PostCardMode.EXECUTING;
    if (this.postStageElement) {
      updatePostStage(this.postStageElement, {
        post: this.props.post,
        mode: this.mode,
        sandboxOrigin: this.props.sandboxOrigin,
        versionId: this.currentVersionId ?? undefined,
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

  private async handleReactionToggle(emoji: string): Promise<void> {
    if (!this.props.currentUser) {
      showSignInPrompt(
        'reaction',
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

    const previous = this.reactions;
    const idx = previous.findIndex((r) => r.emoji === emoji);
    const optimistic = previous.map((r) => ({ ...r }));
    if (idx >= 0) {
      const r = optimistic[idx];
      if (r.reacted) {
        r.count -= 1;
        r.reacted = false;
        if (r.count <= 0) optimistic.splice(idx, 1);
      } else {
        r.count += 1;
        r.reacted = true;
      }
    } else {
      optimistic.push({ emoji, count: 1, reacted: true });
    }
    this.reactions = optimistic;
    this.updateActions();

    try {
      const response = await fetch(`/api/posts/${this.props.post.id}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ emoji }),
      });

      if (!response.ok) {
        throw new Error('Failed to toggle reaction');
      }

      const result = (await response.json()) as {
        emoji: string;
        reacted: boolean;
        reactions: ReactionSummary[];
      };
      this.reactions = result.reactions;

      window.dispatchEvent(
        new CustomEvent('postUpdated', {
          detail: { postId: this.props.post.id, reactions: result.reactions },
        }),
      );
    } catch (error) {
      this.reactions = previous;
      console.error('Failed to toggle reaction:', error);
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

  private navigateToThread(postId: string): void {
    if (this.props.disableNavigation) return;
    const threadUrl = `/thread/${postId}`;
    window.history.pushState({ postId }, '', threadUrl);
    window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'thread', postId } }));
    this.element.dispatchEvent(new CustomEvent('navigateToThread', { detail: { postId } }));
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
      onQuote: () => this.handleQuote(),
    });
  }

  private handleQuote(): void {
    const p = this.props.post;
    const quotedPost: QuotedPost = {
      id: p.id,
      user_id: p.user_id,
      username: p.username,
      display_name: p.display_name,
      avatar_key: p.avatar_key,
      text: p.text,
      hashtags: p.hashtags,
      gif_key: p.gif_key,
      payload_key: p.payload_key,
      swf_key: p.swf_key,
      thumbnail_key: p.thumbnail_key,
      created_at: p.created_at,
    };
    openPostModal({
      currentUser: this.props.currentUser,
      onPostCreated: (post) => this.navigateToThread(post.id),
      quotedPost,
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
    window.history.pushState({ postId: this.props.post.id }, '', threadUrl);

    // Use SPA navigation event
    window.dispatchEvent(
      new CustomEvent('spaNavigate', {
        detail: { view: 'thread', postId: this.props.post.id },
      }),
    );

    // Also emit custom event for navigation (backup)
    const customEvent = new CustomEvent('navigateToThread', {
      detail: { postId: this.props.post.id },
    });
    this.element.dispatchEvent(customEvent);
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
        reactions: this.reactions,
        depth: this.props.depth ?? this.props.post.depth,
        onFreshToggle: () => this.handleFreshToggle(),
        onBookmarkToggle: () => this.handleBookmarkToggle(),
        onReplyToggle: () => this.handleReplyToggle(),
        onShare: () => this.handleShare(),
        onQuote: () => this.handleQuote(),
        onReactionToggle: (emoji) => this.handleReactionToggle(emoji),
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
    if (post.reactions !== undefined) {
      this.reactions = post.reactions;
    }
    this.props.post = { ...this.props.post, ...post };
    this.updateActions();
  }

  private toggleMenu(isOwnPost: boolean): void {
    if (this.menuDropdown) {
      this.menuDropdown.remove();
      this.menuDropdown = undefined;
      return;
    }

    const dropdown = createPostMenuDropdown({
      isOwnPost,
      showPinOption: this.props.showPinOption,
      pinned: this.props.pinned,
      payloadKey: this.props.post.payload_key,
      currentUser: this.props.currentUser,
      actions: {
        onVersionHistory: () =>
          openVersionHistoryModal({
            postId: this.props.post.id,
            sandboxOrigin: this.props.sandboxOrigin,
            currentVersionId: this.currentVersionId,
            onPlay: (versionId) => this.playVersion(versionId),
          }),
        onTogglePin: () => this.props.onTogglePin?.(this.props.post.id),
        onCounterNotice: () => this.showCounterNoticeModal(),
        onEdit: () => this.startEditing(),
        onUpdate: () =>
          openGameUpdateModal({
            postId: this.props.post.id,
            sandboxOrigin: this.props.sandboxOrigin,
            onUpdated: () => this.playVersion(null),
          }),
        onDelete: () => this.showDeleteConfirmation(),
        onBlock: () => this.blockUser(),
        onReport: () => this.showReportModal(),
      },
    });

    const headerContainer = this.element.querySelector('.post-menu-button')?.parentElement;
    if (headerContainer) {
      headerContainer.style.position = 'relative';
      headerContainer.appendChild(dropdown);
    }

    this.menuDropdown = dropdown;
    setupMenuCloseHandler(dropdown, () => {
      this.menuDropdown = undefined;
    });
  }

  private showDeleteConfirmation(): void {
    const { overlay, dialog, close } = createModalOverlay('400px');

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

    document.body.appendChild(overlay);

    cancelBtn.addEventListener('click', close);

    deleteBtn.addEventListener('click', async () => {
      close();
      await this.deletePost();
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

      showToast(t('post.deleted'));
    } catch (error) {
      console.error('Delete post error:', error);
      showToast(t('post.delete_failed'), true);
    }
  }

  private async blockUser(): Promise<void> {
    const username = this.props.post.username;
    try {
      const response = await fetch(`/api/users/${username}/block`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data?.error || 'Failed to block user');
      }

      showToast(t('post.blocked', { username }));

      this.element.style.transition = 'opacity 0.3s, transform 0.3s';
      this.element.style.opacity = '0';
      this.element.style.transform = 'translateX(-100%)';
      setTimeout(() => {
        this.destroy();
      }, 300);
    } catch (error) {
      console.error('Block user error:', error);
      showToast(t('post.block_failed'), true);
    }
  }

  private showReportModal(): void {
    openReportModal(this.props.post.id);
  }

  private showCounterNoticeModal(): void {
    openCounterNoticeModal(this.props.post.id);
  }

  public destroy(): void {
    // Disconnect impression observer
    if (this.impressionObserver) {
      this.impressionObserver.disconnect();
      this.impressionObserver = undefined;
    }

    // Remove pin change listener
    if (this.onPinChanged) {
      window.removeEventListener('profilePinChanged', this.onPinChanged);
      this.onPinChanged = undefined;
    }

    // Cancel any pending sandbox bridge retry
    if (this.sandboxBridgeTimer) {
      clearTimeout(this.sandboxBridgeTimer);
      this.sandboxBridgeTimer = undefined;
    }

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

    // Attachment section (shown when post has attachments)
    const post = this.props.post;
    const attachmentSection = document.createElement('div');
    attachmentSection.style.cssText = `
      margin: 0.5rem 0;
      padding: 0.5rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-secondary);
      font-size: 0.85rem;
    `;

    const currentAttachmentKey = post.gif_key || post.payload_key || post.swf_key;
    const attachmentType = post.gif_key ? 'Image/Audio' : post.payload_key ? 'ZIP' : post.swf_key ? 'SWF' : null;
    const attachmentFileName = currentAttachmentKey
      ? currentAttachmentKey.split('/').pop() || currentAttachmentKey
      : null;

    const attachmentLabel = document.createElement('span');
    attachmentLabel.style.cssText = 'color: var(--text-muted); margin-right: 0.5rem;';
    attachmentLabel.textContent = attachmentFileName
      ? `📎 ${attachmentType}: ${attachmentFileName}`
      : t('post.edit_attachment_none');
    attachmentSection.appendChild(attachmentLabel);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.accept = '.gif,.png,.jpg,.jpeg,.swf,.zip,.mp3,.wav,.ogg,.m4a,.webm,.mp4,.mov';
    attachmentSection.appendChild(fileInput);

    const changeBtn = document.createElement('button');
    changeBtn.textContent = t('post.edit_attachment_change');
    changeBtn.style.cssText = `
      padding: 4px 10px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--bg-primary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 0.8rem;
      margin-right: 0.25rem;
    `;
    changeBtn.addEventListener('click', () => fileInput.click());

    const removeBtn = document.createElement('button');
    removeBtn.textContent = t('post.edit_attachment_remove');
    removeBtn.style.cssText = `
      padding: 4px 10px;
      border: 1px solid var(--danger, #e74c3c);
      border-radius: 4px;
      background: transparent;
      color: var(--danger, #e74c3c);
      cursor: pointer;
      font-size: 0.8rem;
    `;
    removeBtn.addEventListener('click', () => {
      this.editRemoveAttachment = true;
      this.editAttachmentFile = null;
      this.editNewAttachmentKey = null;
      attachmentLabel.textContent = t('post.edit_attachment_removed');
      changeBtn.disabled = true;
      removeBtn.disabled = true;
      changeBtn.style.opacity = '0.5';
      removeBtn.style.opacity = '0.5';
    });

    if (currentAttachmentKey) {
      attachmentSection.appendChild(changeBtn);
      attachmentSection.appendChild(removeBtn);
    } else {
      attachmentSection.appendChild(changeBtn);
    }

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      this.editAttachmentFile = file;
      this.editRemoveAttachment = false;
      attachmentLabel.textContent = `📎 ${file.name}`;
      changeBtn.textContent = t('post.edit_attachment_change');
    });

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
      const hasAttachmentChanges = this.editAttachmentFile || this.editRemoveAttachment;
      if ((!newText || newText === currentText) && !hasAttachmentChanges) {
        this.cancelEdit();
        return;
      }
      saving = true;
      saveBtn.disabled = true;
      saveBtn.textContent = '...';
      try {
        // Upload new attachment if selected
        let newGifKey: string | undefined;
        let newPayloadKey: string | undefined;
        let newSwfKey: string | undefined;

        if (this.editAttachmentFile) {
          const file = this.editAttachmentFile;
          const prepareRes = await fetch(`/api/posts/${post.id}/prepare-attachment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ filename: file.name }),
          });
          if (!prepareRes.ok) throw new Error('Failed to prepare attachment upload');
          const prepareData = (await prepareRes.json()) as {
            uploadUrl: string;
            key: string;
            keyType: string;
          };

          const uploadRes = await fetch(prepareData.uploadUrl, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': file.type },
            credentials: 'include',
          });
          if (!uploadRes.ok) throw new Error('Failed to upload attachment');

          this.editNewAttachmentKey = prepareData.key;
          if (prepareData.keyType === 'gif') newGifKey = prepareData.key;
          else if (prepareData.keyType === 'payload') newPayloadKey = prepareData.key;
          else if (prepareData.keyType === 'swf') newSwfKey = prepareData.key;
        }

        const body: Record<string, unknown> = {};
        if (newText && newText !== currentText) body.text = newText;
        if (this.editNewAttachmentKey) {
          if (newGifKey) body.gif_key = newGifKey;
          else if (newPayloadKey) body.payload_key = newPayloadKey;
          else if (newSwfKey) body.swf_key = newSwfKey;
        }
        if (this.editRemoveAttachment) {
          if (post.gif_key) body.gif_key = null;
          if (post.payload_key) body.payload_key = null;
          if (post.swf_key) body.swf_key = null;
        }

        const res = await fetch(`/api/posts/${post.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string })?.error || 'Edit failed');
        }
        const data = (await res.json()) as {
          post: { text: string; edited_at: string; gif_key?: string; payload_key?: string; swf_key?: string };
        };
        this.originalText = data.post.text;
        this.props.post.text = data.post.text;
        this.props.post.edited_at = data.post.edited_at;
        if (data.post.gif_key !== undefined) this.props.post.gif_key = data.post.gif_key;
        if (data.post.payload_key !== undefined) this.props.post.payload_key = data.post.payload_key;
        if (data.post.swf_key !== undefined) this.props.post.swf_key = data.post.swf_key;
        this.cancelEdit();
        showToast(t('post.edit_saved'));
      } catch (_err) {
        showToast(t('post.edit_failed'), true);
      } finally {
        saving = false;
        saveBtn.disabled = false;
        saveBtn.textContent = t('post.edit_save');
        this.editAttachmentFile = null;
        this.editNewAttachmentKey = null;
        this.editRemoveAttachment = false;
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
    this.editContainer.appendChild(attachmentSection);
    this.editContainer.appendChild(buttonRow);

    textElement.replaceWith(this.editContainer);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  private cancelEdit(): void {
    if (!this.isEditing || !this.editContainer || !this.postTextContainer) return;
    this.isEditing = false;
    this.editAttachmentFile = null;
    this.editNewAttachmentKey = null;
    this.editRemoveAttachment = false;

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
