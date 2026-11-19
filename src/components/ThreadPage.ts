import { stripPostColors } from '../../shared/post-colors.ts';
import { Post } from '../../shared/types/post.ts';
import { formatCount } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { nativeApiHref } from '../lib/native-api.js';
import { each, legacy, type Mounted, mount, type Renderable, type Signal, signal } from '../lib/render/index.ts';
import { updateMetaTags } from '../lib/seo-meta.js';
import { getReplyStyle } from '../lib/settings.js';
import { pushSpaHistory } from '../lib/spa-history.js';
import { buildTree, type PostNode } from '../lib/thread.ts';
import { createLeftNav } from './LeftNav.js';
import { createPostCard } from './PostCard.js';
import { createReplyComposer, ReplyComposer } from './ReplyComposer.js';
import { createReplyNode } from './ReplyNode.js';
import { showSignInPrompt } from './SignInPrompt.js';

type ThreadReplyEntry =
  | { key: string; kind: 'flat'; post: Post; index?: number }
  | { key: string; kind: 'tree'; node: PostNode };

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
  private leftNav?: ReturnType<typeof createLeftNav>;
  private boundPostUpdatedHandler?: (e: Event) => void;
  private currentReplies: Post[] = [];
  private replyIndexMap: Map<string, number> = new Map();
  private repliesSignal: Signal<ThreadReplyEntry[]> = signal<ThreadReplyEntry[]>([]);
  private repliesMount?: Mounted;
  private repliesHeaderEl?: HTMLElement;
  private repliesEmptyEl?: HTMLElement;

  constructor(props: ThreadPageProps) {
    this.props = props;
    this.element = this.createElement();
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
    const reply = newReply as unknown as Post;
    if (!reply?.id || this.currentReplies.some((existing) => existing.id === reply.id)) return;

    this.currentReplies = [...this.currentReplies, reply];
    this.replyIndexMap.set(reply.id, this.currentReplies.length);
    this.renderReplies();

    const index = this.replyIndexMap.get(reply.id);
    requestAnimationFrame(() => {
      const element = this.element.querySelector(`[data-post-index="${index}"]`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'thread-page';
    container.style.cssText = `
      background: var(--bg-primary);
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
        if (item === 'home') {
          pushSpaHistory('/home');
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'timeline' } }));
        } else if (item === 'explore') {
          pushSpaHistory('/explore');
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'explore' } }));
        } else if (item === 'arcade') {
          pushSpaHistory('/arcade');
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'arcade' } }));
        } else if (item === 'notifications') {
          if (this.props.currentUser) {
            pushSpaHistory('/notifications');
            window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'notifications' } }));
          }
        } else if (item === 'bookmarks') {
          if (this.props.currentUser) {
            pushSpaHistory('/bookmarks');
            window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'bookmarks' } }));
          }
        } else if (item === 'settings') {
          pushSpaHistory('/settings');
          window.dispatchEvent(new CustomEvent('spaNavigate', { detail: { view: 'settings' } }));
        } else if (item === 'profile') {
          if (this.props.currentUser) {
            pushSpaHistory(`/profile/${this.props.currentUser.username}`);
            window.dispatchEvent(
              new CustomEvent('spaNavigate', {
                detail: { view: 'profile', username: this.props.currentUser.username },
              }),
            );
          }
        }
      },
      onSignIn: () => {
        pushSpaHistory('/login');
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      onSignUp: () => {
        pushSpaHistory('/register');
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
    });
    this.leftNav.getElement().style.cssText = `
      flex-shrink: 0;
      padding: 1rem;
      border-right: 1px solid var(--border);
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
      background: var(--bg-primary);
      border-bottom: 1px solid var(--border);
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
      color: var(--accent-text);
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
      color: var(--text-primary);
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

    const repliesHeader = document.createElement('h2');
    repliesHeader.id = 'thread-replies-header';
    repliesHeader.hidden = true;
    repliesHeader.style.cssText = `
      color: var(--text-muted);
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 1rem;
      margin: 0 0 1rem 0;
      padding-top: 1rem;
      font-weight: normal;
    `;
    this.repliesHeaderEl = repliesHeader;

    const repliesEmpty = document.createElement('p');
    repliesEmpty.textContent = t('thread.no_replies');
    repliesEmpty.hidden = true;
    repliesEmpty.style.cssText = `
      color: var(--text-muted);
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
      padding: 2rem;
      font-style: italic;
    `;
    this.repliesEmptyEl = repliesEmpty;

    const repliesHost = document.createElement('div');
    repliesHost.className = 'replies-container';
    this.repliesMount = mount(repliesHost, () =>
      each(
        () => this.repliesSignal(),
        (entry) => entry.key,
        (entry) => this.renderReplyEntry(entry()),
      ),
    );

    repliesContent.appendChild(repliesHeader);
    repliesContent.appendChild(repliesEmpty);
    repliesContent.appendChild(repliesHost);

    // One handler for >>N references; the list is reused across loads.
    repliesContent.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const refLink = target.classList.contains('post-ref-link')
        ? target
        : (target.closest('.post-ref-link') as HTMLElement | null);
      if (!refLink) return;
      e.preventDefault();
      const index = refLink.dataset.postIndex;
      if (!index) return;
      const targetPost = repliesContent.querySelector(`[data-post-index="${index}"]`);
      targetPost?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    // Loading state
    const loading = document.createElement('div');
    loading.className = 'thread-loading';
    loading.textContent = t('thread.loading');
    loading.style.cssText = `
      color: var(--text-muted);
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

  private addResponsiveStyles(container: HTMLElement): void {
    const style = document.createElement('style');
    style.textContent = `
      @media (max-width: 1024px) {
        .thread-page .main-container {
          max-width: 840px;
        }
      }
      
      @media (max-width: 768px) {
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
          border-right: 1px solid var(--border);
          border-top: none;
          padding: 1rem;
          z-index: 1100;
          transform: translateX(-100%);
          transition: transform 0.3s ease;
          background: var(--bg-primary);
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

  private renderReplyEntry(entry: ThreadReplyEntry): Renderable {
    if (entry.kind === 'tree') {
      const replyNode = createReplyNode({
        node: entry.node,
        sandboxOrigin: this.props.sandboxOrigin,
        currentUser: this.props.currentUser,
        onReplyCreated: (newReply) => this.handleReplyCreated(newReply),
        postIndexMap: this.replyIndexMap,
      });
      return legacy(replyNode.getElement(), () => replyNode.destroy());
    }

    const card = createPostCard({
      post: entry.post,
      sandboxOrigin: this.props.sandboxOrigin,
      currentUser: this.props.currentUser || undefined,
      depth: entry.post.depth,
      onDelete: () => {},
      disableNavigation: true,
      postIndex: entry.index,
      enablePostRefs: true,
    });
    return legacy(card.getElement(), () => card.destroy());
  }

  private renderReplies(): void {
    const replyStyle = getReplyStyle();
    const entries: ThreadReplyEntry[] = [];
    if (replyStyle === 'twitter') {
      for (const node of buildTree(this.currentReplies)) {
        entries.push({ key: node.post.id, kind: 'tree', node });
      }
    } else {
      this.currentReplies.forEach((reply) => {
        entries.push({
          key: reply.id,
          kind: 'flat',
          post: reply,
          index: this.replyIndexMap.get(reply.id),
        });
      });
    }

    this.repliesSignal.set(entries);
    if (this.repliesHeaderEl) {
      this.repliesHeaderEl.textContent = `${t('thread.replies_header', {
        count: formatCount(this.currentReplies.length),
      })}`;
      this.repliesHeaderEl.hidden = false;
    }
    if (this.repliesEmptyEl) this.repliesEmptyEl.hidden = entries.length > 0;
  }

  private clearThreadContent(): void {
    // Clean up existing reply nodes
    this.currentReplies = [];
    this.replyIndexMap = new Map();
    this.repliesSignal.set([]);
    if (this.repliesHeaderEl) this.repliesHeaderEl.hidden = true;
    if (this.repliesEmptyEl) this.repliesEmptyEl.hidden = true;

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

    this.isRootReplyComposerOpen = false;
  }

  private async loadThread(): Promise<void> {
    const rootContainer = this.element.querySelector('.thread-root-post-container') as HTMLElement;
    const loading = this.element.querySelector('.thread-loading') as HTMLElement;

    // Clear existing content before reloading
    this.clearThreadContent();

    try {
      const response = await fetch(`/api/posts/${this.props.postId}/thread`);
      if (!response.ok) {
        throw new Error('Failed to load thread');
      }

      const data = (await response.json()) as { root?: Post; replies?: Post[] };
      const replies = Array.isArray(data.replies) ? data.replies : [];
      const root = data.root;
      if (!root) {
        // A malformed payload is not an exception worth logging: show the
        // "could not load" state and leave the rest of the page intact.
        loading.textContent = t('thread.load_failed');
        loading.style.color = '#ef4444';
        return;
      }

      // Notify cached PostCards (e.g. in Timeline) about updated reply count
      window.dispatchEvent(
        new CustomEvent('postUpdated', {
          detail: { postId: this.props.postId, replyCount: replies.length },
        }),
      );

      // Assign sequential indices only to replies (root excluded)
      const postIdToIndex = new Map<string, number>();
      replies.forEach((p, i) => void postIdToIndex.set(p.id, i + 1));

      // Clear loading state
      loading.style.display = 'none';

      // Create root post card (with reply button but without built-in reply composer)
      this.rootPostCard = createPostCard({
        post: root,
        sandboxOrigin: this.props.sandboxOrigin,
        currentUser: this.props.currentUser || undefined,
        depth: root.depth,
        onDelete: () => {}, // Add empty onDelete handler to prevent errors
        disableReplyComposer: true, // Disable only built-in reply composer, ThreadPage will handle replies
      });
      rootContainer.appendChild(this.rootPostCard.getElement());

      // Sync post card reply count with actual thread data
      this.rootPostCard.updatePost({ reply_count: replies.length });

      // Update page metadata for accurate OGP regardless of client-side navigation
      this.updateMetaTags(root);

      // Root reply composer (hidden by default)
      this.rootReplyComposer = createReplyComposer({
        postId: root.id,
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
        if (customEvent.detail.postId === root.id) {
          this.toggleRootReplyComposer();
        }
      }) as EventListener);

      this.currentReplies = replies;
      this.replyIndexMap = postIdToIndex;
      this.renderReplies();
    } catch (error) {
      console.error('Failed to load thread:', error);
      loading.textContent = t('thread.load_failed');
      loading.style.color = '#ef4444';
    } finally {
    }
  }

  private handleRootReplyCreated(newReply: Post): void {
    this.hideRootReplyComposer();

    if (!this.currentReplies.some((existing) => existing.id === newReply.id)) {
      this.currentReplies = [...this.currentReplies, newReply];
      this.replyIndexMap.set(newReply.id, this.currentReplies.length);
    }
    this.renderReplies();

    const index = this.replyIndexMap.get(newReply.id);
    requestAnimationFrame(() => {
      const element = this.element.querySelector(`[data-post-index="${index}"]`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    if (this.rootPostCard) {
      this.rootPostCard.updatePost({ reply_count: this.currentReplies.length });
    }

    window.dispatchEvent(
      new CustomEvent('postUpdated', {
        detail: { postId: this.props.postId, replyCount: this.currentReplies.length },
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
          pushSpaHistory('/login');
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
        () => {
          pushSpaHistory('/register');
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
    // ReplyNode has already inserted the child into the DOM. Keep the source
    // list current so a later tree rebuild (for example, a new root reply)
    // preserves this child.
    if (!this.currentReplies.some((existing) => existing.id === newReply.id)) {
      this.currentReplies = [...this.currentReplies, newReply];
      this.replyIndexMap.set(newReply.id, this.currentReplies.length);
    }
    if (this.rootPostCard) {
      this.rootPostCard.updatePost({ reply_count: this.currentReplies.length });
    }
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.repliesMount?.dispose();
    this.repliesMount = undefined;
    this.repliesSignal.set([]);

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

  private async updateMetaTags(post: Post): Promise<void> {
    const name = post.display_name || post.username;
    const imageKey =
      post.gif_key && !post.gif_key.startsWith('audio/')
        ? post.gif_key
        : post.thumbnail_key
          ? post.thumbnail_key
          : null;

    let ogImage: string | undefined;
    if (imageKey) {
      ogImage = nativeApiHref(`/api/images/${imageKey}`);
    }

    updateMetaTags({
      title: `Flaxia - ${name}`,
      description: stripPostColors(post.text).slice(0, 200),
      url: `${window.location.origin}/thread/${post.id}`,
      image: ogImage,
    });
  }
}

// Factory function for easier usage
export function createThreadPage(props: ThreadPageProps): ThreadPage {
  return new ThreadPage(props);
}
