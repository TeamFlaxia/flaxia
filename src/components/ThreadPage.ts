import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { getReplyStyle } from '../lib/settings.js';
import { buildTree } from '../lib/thread.js';
import { Post } from '../types/post.js';
import { createLeftNav } from './LeftNav.js';
import { createPostCard } from './PostCard.js';
import { createReplyComposer, ReplyComposer } from './ReplyComposer.js';
import { createReplyNode, ReplyNode } from './ReplyNode.js';
import { showSignInPrompt } from './SignInPrompt.js';

export interface ThreadPageProps {
  postId: string;
  sandboxOrigin: string;
  onBack: () => void;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
  unreadCount?: number;
}

export class ThreadPage {
  private element: HTMLElement;
  private props: ThreadPageProps;
  private rootPostCard?: ReturnType<typeof createPostCard>;
  private rootReplyComposer?: ReplyComposer;
  private isRootReplyComposerOpen: boolean = false;
  private replyNodes: ReplyNode[] = [];
  private leftNav?: ReturnType<typeof createLeftNav>;
  private boundPostUpdatedHandler?: (e: Event) => void;

  constructor(props: ThreadPageProps) {
    this.props = props;
    this.element = this.createElement();
    this.setupSwipeDetection();
    this.setupPostUpdatedListener();
    this.loadThread();
  }

  private setupPostUpdatedListener(): void {
    this.boundPostUpdatedHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.reply) return;
      const replyRootId = (detail.reply as Record<string, unknown>)?.root_id;
      if (!replyRootId || replyRootId !== this.props.postId) return;
      // For flat mode (2ch): when a reply is created via inline PostCard composer,
      // insert the reply into the flat list.
      const replyStyle = getReplyStyle();
      if (replyStyle !== 'twitter') {
        this.insertFlatReply(detail.reply);
      }
    };
    window.addEventListener('postUpdated', this.boundPostUpdatedHandler);
  }

  private insertFlatReply(newReply: Record<string, unknown>): void {
    const repliesContent = this.element.querySelector('.thread-replies-content') as HTMLElement;
    if (!repliesContent) return;

    const repliesContainer = repliesContent.querySelector('.replies-container') as HTMLElement;
    if (!repliesContainer) return;

    // Append new reply at the end (matching API ordering: oldest-first)
    const nextIndex = repliesContainer.children.length + 1;
    const card = createPostCard({
      post: newReply as unknown as Post,
      sandboxOrigin: this.props.sandboxOrigin,
      currentUser: this.props.currentUser || undefined,
      depth: (newReply.depth as number) || 0,
      onDelete: () => {},
      disableNavigation: true,
      postIndex: nextIndex,
      enablePostRefs: true,
    });
    const cardEl = card.getElement();
    repliesContainer.appendChild(cardEl);
    cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Update replies header count
    const header = repliesContent.querySelector('#thread-replies-header, h2') as HTMLElement;
    if (header) {
      header.textContent = t('thread.replies_header', { count: formatCount(repliesContainer.children.length) });
    }
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'thread-page';
    container.style.cssText = `
      background: #ffffff;
      min-height: 100vh;
      width: 100%;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    // Create main container with 3-column layout
    const mainContainer = document.createElement('div');
    mainContainer.className = 'main-container';
    mainContainer.style.cssText = `
      display: flex;
      width: 100%;
      max-width: 1200px;
      margin: 0 auto;
    `;

    // Create Left Nav
    this.leftNav = createLeftNav({
      activeItem: 'home',
      unreadCount: this.props.unreadCount ?? 0,
      currentUser: this.props.currentUser || undefined,
      onNavigate: async (item) => {
        console.log('Navigate to:', item);
        if (item === 'home') {
          window.history.pushState({}, '', '/home');
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'timeline' } }));
        } else if (item === 'explore') {
          window.history.pushState({}, '', '/explore');
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore' } }));
        } else if (item === 'arcade') {
          window.history.pushState({}, '', '/arcade');
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'arcade' } }));
        } else if (item === 'notifications') {
          if (this.props.currentUser) {
            window.history.pushState({}, '', '/notifications');
            window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'notifications' } }));
          }
        } else if (item === 'bookmarks') {
          if (this.props.currentUser) {
            window.history.pushState({}, '', '/bookmarks');
            window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'bookmarks' } }));
          }
        } else if (item === 'settings') {
          window.history.pushState({}, '', '/settings');
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'settings' } }));
        } else if (item === 'profile') {
          if (this.props.currentUser) {
            window.history.pushState({}, '', `/profile/${this.props.currentUser.username}`);
            window.dispatchEvent(
              new CustomEvent('spaNavigate', {
                detail: { view: 'profile', username: this.props.currentUser.username },
              }),
            );
          }
        }
      },
      onSignIn: () => {
        window.history.pushState({}, '', '/login');
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      onSignUp: () => {
        window.history.pushState({}, '', '/register');
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
    });
    this.leftNav.getElement().style.cssText = `
      flex-shrink: 0;
      padding: 1rem;
      border-right: 1px solid #e2e8f0;
    `;

    // Create main content area
    const mainContent = document.createElement('div');
    mainContent.className = 'thread-main-content';
    mainContent.style.cssText = `
      flex: 1;
      padding: 1rem;
    `;

    // Sticky top section: header only
    const topSection = document.createElement('div');
    topSection.className = 'thread-top-section';
    topSection.style.cssText = `
      position: sticky;
      top: 0;
      z-index: 10;
      background: #ffffff;
      border-bottom: 1px solid #e2e8f0;
      margin-bottom: 1rem;
    `;

    // Thread header
    const header = document.createElement('div');
    header.className = 'thread-header';
    header.style.cssText = `
      display: flex;
      align-items: center;
      padding-bottom: 1rem;
      padding-top: 0.5rem;
    `;

    const backButton = document.createElement('button');
    backButton.textContent = t('common.back');
    backButton.style.cssText = `
      background: none;
      border: none;
      color: #22c55e;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 1rem;
      cursor: pointer;
      padding: 0.5rem;
      margin-right: 1rem;
    `;
    backButton.addEventListener('click', this.props.onBack);

    const title = document.createElement('h1');
    title.textContent = t('thread.title');
    title.style.cssText = `
      color: #0f172a;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 1.25rem;
      margin: 0;
      font-weight: normal;
    `;

    header.appendChild(backButton);
    header.appendChild(title);
    topSection.appendChild(header);

    // Root post area (populated by loadThread)
    const rootPostContainer = document.createElement('div');
    rootPostContainer.className = 'thread-root-post-container';

    // Replies content (scrollable)
    const repliesContent = document.createElement('div');
    repliesContent.className = 'thread-replies-content';
    repliesContent.id = `thread-replies-${this.props.postId}`;

    // Loading state
    const loading = document.createElement('div');
    loading.className = 'thread-loading';
    loading.textContent = t('thread.loading');
    loading.style.cssText = `
      color: #64748b;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
      padding: 4rem 2rem;
      font-size: 1.125rem;
    `;

    // Assemble main content
    mainContent.appendChild(topSection);
    mainContent.appendChild(rootPostContainer);
    mainContent.appendChild(repliesContent);
    mainContent.appendChild(loading);

    // Assemble layout
    mainContainer.appendChild(this.leftNav.getElement());
    mainContainer.appendChild(mainContent);
    container.appendChild(mainContainer);

    // Add responsive styles
    this.addResponsiveStyles(container);

    return container;
  }

  private setupSwipeDetection(): void {
    // Mobile left nav gestures are disabled. Navigation is opened only by the explicit menu button.
    return;
  }

  private addResponsiveStyles(container: HTMLElement): void {
    const style = document.createElement('style');
    style.textContent = `
      @media (max-width: 1024px) {
        .thread-page .main-container {
          max-width: 840px;
        }
      }
      
      @media (max-width: 768px) {
        .left-nav-open-button {
          top: 30%;
        }
        .thread-page .main-container {
          flex-direction: column;
          max-width: 100%;
        }
        .thread-page .left-nav {
          position: fixed;
          top: 0;
          left: 0;
          width: 280px;
          height: 100vh;
          border-right: 1px solid #e2e8f0;
          border-top: none;
          padding: 1rem;
          z-index: 1100;
          transform: translateX(-100%);
          transition: transform 0.3s ease;
          background: #ffffff;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
        }
        .thread-page .left-nav.left-nav--open {
          transform: translateX(0);
          box-shadow: 4px 0 12px rgba(0, 0, 0, 0.15);
        }
        .thread-page .thread-main-content {
          padding-bottom: 1rem;
          max-width: 100%;
        }
        /* Show all nav items in slide-out */
        .thread-page .nav-logo,
        .thread-page .nav-user-area,
        .thread-page .nav-legal-links {
          display: block !important;
        }
        .thread-page .nav-items {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          margin-bottom: 2rem;
        }
        .thread-page .nav-item {
          justify-content: flex-start;
          padding: 0.75rem 1rem;
          font-size: 1rem;
          border-radius: 9999px;
        }
        .thread-page .nav-item span:not(.nav-badge):first-child {
          margin-right: 0.75rem;
        }
        .thread-page .nav-item span:not(.nav-badge):not(:first-child) {
          display: inline;
        }
      }
    `;
    container.appendChild(style);
  }

  private clearThreadContent(): void {
    // Clean up existing reply nodes
    this.replyNodes.forEach((node) => void node.destroy());
    this.replyNodes = [];

    // Clean up root post card
    if (this.rootPostCard) {
      this.rootPostCard.destroy();
      this.rootPostCard = undefined;
    }

    // Clean up root reply composer
    if (this.rootReplyComposer) {
      this.rootReplyComposer.destroy();
      this.rootReplyComposer = undefined;
    }

    // Clear containers
    const rootContainer = this.element.querySelector('.thread-root-post-container') as HTMLElement;
    if (rootContainer) rootContainer.innerHTML = '';

    const repliesContent = this.element.querySelector('.thread-replies-content') as HTMLElement;
    if (repliesContent) repliesContent.innerHTML = '';

    this.isRootReplyComposerOpen = false;
  }

  private async loadThread(): Promise<void> {
    const rootContainer = this.element.querySelector('.thread-root-post-container') as HTMLElement;
    const repliesContent = this.element.querySelector('.thread-replies-content') as HTMLElement;
    const loading = this.element.querySelector('.thread-loading') as HTMLElement;

    // Clear existing content before reloading
    this.clearThreadContent();

    try {
      const response = await fetch(`/api/posts/${this.props.postId}/thread`);
      if (!response.ok) {
        throw new Error('Failed to load thread');
      }

      const data = (await response.json()) as { root: Post; replies: Post[] };

      // Notify cached PostCards (e.g. in Timeline) about updated reply count
      window.dispatchEvent(
        new CustomEvent('postUpdated', {
          detail: { postId: this.props.postId, replyCount: data.replies.length },
        }),
      );

      // Assign sequential indices only to replies (root excluded)
      const postIdToIndex = new Map<string, number>();
      data.replies.forEach((p, i) => void postIdToIndex.set(p.id, i + 1));

      // Clear loading state
      loading.style.display = 'none';

      // Create root post card (with reply button but without built-in reply composer)
      this.rootPostCard = createPostCard({
        post: data.root,
        sandboxOrigin: this.props.sandboxOrigin,
        currentUser: this.props.currentUser || undefined,
        depth: data.root.depth,
        onDelete: () => {}, // Add empty onDelete handler to prevent errors
        disableReplyComposer: true, // Disable only built-in reply composer, ThreadPage will handle replies
      });
      rootContainer.appendChild(this.rootPostCard.getElement());

      // Sync post card reply count with actual thread data
      this.rootPostCard.updatePost({ reply_count: data.replies.length });

      // Root reply composer (hidden by default)
      this.rootReplyComposer = createReplyComposer({
        postId: data.root.id,
        sandboxOrigin: this.props.sandboxOrigin,
        onReplyCreated: (newReply) => this.handleRootReplyCreated(newReply),
        onCancel: () => this.hideRootReplyComposer(),
        currentUser: this.props.currentUser,
      });
      this.rootReplyComposer.getElement().style.display = 'none';
      rootContainer.appendChild(this.rootReplyComposer.getElement());

      // Setup event listener for root post reply toggle
      this.rootPostCard.getElement().addEventListener('replyToggle', ((e: Event) => {
        const customEvent = e as CustomEvent;
        if (customEvent.detail.postId === data.root.id) {
          this.toggleRootReplyComposer();
        }
      }) as EventListener);

      // Add replies header
      const repliesHeader = document.createElement('h2');
      repliesHeader.textContent = t('thread.replies_header', { count: formatCount(data.replies.length) });
      repliesHeader.style.cssText = `
        color: #64748b;
        font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 1rem;
        margin: 0 0 1rem 0;
        padding-top: 1rem;
        font-weight: normal;
      `;
      repliesContent.appendChild(repliesHeader);

      const replyStyle = getReplyStyle();

      if (data.replies.length > 0) {
        const repliesContainer = document.createElement('div');
        repliesContainer.className = 'replies-container';

        if (replyStyle === 'twitter') {
          // Twitter-style: tree view with ReplyNode
          const replyTree = buildTree(data.replies);

          replyTree.forEach((node) => {
            const replyNode = createReplyNode({
              node,
              sandboxOrigin: this.props.sandboxOrigin,
              currentUser: this.props.currentUser,
              onReplyCreated: (newReply) => this.handleReplyCreated(newReply),
              postIndexMap: postIdToIndex,
            });
            this.replyNodes.push(replyNode);
            repliesContainer.appendChild(replyNode.getElement());
          });
        } else {
          // 2ch-style: flat list with sequential indices
          for (const reply of data.replies) {
            const nodeIndex = postIdToIndex.get(reply.id);
            const card = createPostCard({
              post: reply,
              sandboxOrigin: this.props.sandboxOrigin,
              currentUser: this.props.currentUser || undefined,
              depth: reply.depth,
              onDelete: () => {},
              disableNavigation: true,
              postIndex: nodeIndex,
              enablePostRefs: true,
            });
            repliesContainer.appendChild(card.getElement());
          }
        }

        repliesContent.appendChild(repliesContainer);
      } else {
        const noReplies = document.createElement('p');
        noReplies.textContent = t('thread.no_replies');
        noReplies.style.cssText = `
          color: #64748b;
          font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          text-align: center;
          padding: 2rem;
          font-style: italic;
        `;
        repliesContent.appendChild(noReplies);
      }

      // Click handler for >>N post references (scroll to referenced reply)
      repliesContent.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const refLink = target.classList.contains('post-ref-link')
          ? target
          : (target.closest('.post-ref-link') as HTMLElement | null);
        if (refLink) {
          e.preventDefault();
          const index = refLink.dataset.postIndex;
          if (index) {
            const targetPost = repliesContent.querySelector(`[data-post-index="${index}"]`);
            if (targetPost) {
              targetPost.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        }
      });
    } catch (error) {
      console.error('Failed to load thread:', error);
      loading.textContent = t('thread.load_failed');
      loading.style.color = '#ef4444';
    } finally {
    }
  }

  private handleRootReplyCreated(newReply: Post): void {
    this.hideRootReplyComposer();

    const repliesContent = this.element.querySelector('.thread-replies-content') as HTMLElement;
    if (!repliesContent) return;

    // Remove "no replies" placeholder if present
    const noReplies = repliesContent.querySelector('.thread-no-replies, p');
    if (noReplies && !noReplies.closest('.replies-container') && !noReplies.closest('.reply-node')) {
      noReplies.remove();
    }

    // Get or create replies container
    let repliesContainer = repliesContent.querySelector('.replies-container') as HTMLElement;
    if (!repliesContainer) {
      // Create replies header
      const repliesHeader = document.createElement('h2');
      repliesHeader.id = 'thread-replies-header';
      repliesHeader.textContent = t('thread.replies_header', { count: formatCount(1) });
      repliesHeader.style.cssText = `
        color: #64748b;
        font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 1rem;
        margin: 0 0 1rem 0;
        padding-top: 1rem;
        font-weight: normal;
      `;
      repliesContent.appendChild(repliesHeader);

      repliesContainer = document.createElement('div');
      repliesContainer.className = 'replies-container';
      repliesContent.appendChild(repliesContainer);
    } else {
      // Update replies header count
      const header = repliesContent.querySelector('#thread-replies-header, h2') as HTMLElement;
      if (header) {
        const currentCount = repliesContainer.children.length;
        header.textContent = t('thread.replies_header', { count: formatCount(currentCount + 1) });
      }
    }

    const replyStyle = getReplyStyle();
    if (replyStyle === 'twitter') {
      // Tree mode: create a ReplyNode for the new reply
      const node = { post: newReply, children: [] };
      const nextIndex = repliesContainer.children.length + 1;
      const indexMap = new Map<string, number>();
      indexMap.set(newReply.id, nextIndex);
      const replyNode = createReplyNode({
        node,
        sandboxOrigin: this.props.sandboxOrigin,
        currentUser: this.props.currentUser,
        onReplyCreated: (reply) => this.handleReplyCreated(reply),
        postIndexMap: indexMap,
      });
      this.replyNodes.push(replyNode);
      const replyEl = replyNode.getElement();
      repliesContainer.appendChild(replyEl);
      replyEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // 2ch flat mode: append as PostCard (matching API ordering)
      const nextIndex = repliesContainer.children.length + 1;
      const card = createPostCard({
        post: newReply,
        sandboxOrigin: this.props.sandboxOrigin,
        currentUser: this.props.currentUser || undefined,
        depth: newReply.depth,
        onDelete: () => {},
        disableNavigation: true,
        postIndex: nextIndex,
        enablePostRefs: true,
      });
      const cardEl = card.getElement();
      repliesContainer.appendChild(cardEl);
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Update root post reply count
    if (this.rootPostCard) {
      const currentCount = this.rootPostCard.getReplyCount() || 0;
      this.rootPostCard.updatePost({ reply_count: currentCount + 1 });
    }

    // Notify Timeline PostCards about updated reply count
    window.dispatchEvent(
      new CustomEvent('postUpdated', {
        detail: { postId: this.props.postId, replyCount: repliesContainer.children.length },
      }),
    );
  }

  private toggleRootReplyComposer(): void {
    if (this.isRootReplyComposerOpen) {
      this.hideRootReplyComposer();
    } else {
      this.showRootReplyComposer();
    }
  }

  private showRootReplyComposer(): void {
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
    if (this.rootReplyComposer) {
      // Dispatch global event to close other reply composers
      document.dispatchEvent(
        new CustomEvent('replyComposerOpen', {
          detail: { postId: this.props.postId },
        }),
      );

      this.rootReplyComposer.getElement().style.display = 'block';
      this.isRootReplyComposerOpen = true;
      this.rootReplyComposer.focus();
    }
  }

  private hideRootReplyComposer(): void {
    if (this.rootReplyComposer) {
      this.rootReplyComposer.getElement().style.display = 'none';
      this.isRootReplyComposerOpen = false;
    }
  }

  private handleReplyCreated(newReply: Post): void {
    // In tree mode, ReplyNode.handleReplyCreated already inserts the child reply into the DOM.
    // Just update root reply count.
    if (this.rootPostCard) {
      this.rootPostCard.updatePost({ reply_count: (this.rootPostCard.getReplyCount() || 0) + 1 });
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    // Cleanup reply nodes
    this.replyNodes.forEach((node) => void node.destroy());
    this.replyNodes = [];

    // Cleanup root post card
    if (this.rootPostCard) {
      this.rootPostCard.destroy();
      this.rootPostCard = undefined;
    }

    // Cleanup root reply composer
    if (this.rootReplyComposer) {
      this.rootReplyComposer.destroy();
      this.rootReplyComposer = undefined;
    }

    // Cleanup event listener
    if (this.boundPostUpdatedHandler) {
      window.removeEventListener('postUpdated', this.boundPostUpdatedHandler);
      this.boundPostUpdatedHandler = undefined;
    }

    // Cleanup left nav
    if (this.leftNav) {
      this.leftNav.destroy();
      this.leftNav = undefined;
    }

    this.element.remove();
  }
}

// Factory function for easier usage
export function createThreadPage(props: ThreadPageProps): ThreadPage {
  return new ThreadPage(props);
}
