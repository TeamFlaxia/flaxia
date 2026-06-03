import { t } from '../lib/i18n.js';
import { buildTree } from '../lib/thread.js';
import { Post } from '../types/post.js';
import { createPostCard, PostCard as PostCardClass } from './PostCard.js';
import { createReplyNode, ReplyNode } from './ReplyNode.js';

export interface ThreadViewProps {
  postId: string;
  sandboxOrigin: string;
  onClose: () => void;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
}

export class ThreadView {
  private element: HTMLElement;
  private props: ThreadViewProps;
  private rootPostCard?: PostCardClass;
  private replyNodes: ReplyNode[] = [];

  constructor(props: ThreadViewProps) {
    this.props = props;
    this.element = this.createElement();
    this.loadThread();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'thread-view';
    container.style.cssText = `
      background: #0f172a;
      border-top: 1px solid #1e293b;
      padding: 1rem;
      min-height: 400px;
    `;

    // Header
    const header = document.createElement('div');
    header.className = 'thread-header';
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #1e293b;
    `;

    const title = document.createElement('h3');
    title.textContent = t('thread_view.title');
    title.style.cssText = `
      color: #f8fafc;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 1rem;
      margin: 0;
    `;

    const closeButton = document.createElement('button');
    closeButton.textContent = t('thread_view.close');
    closeButton.style.cssText = `
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0;
      width: 2rem;
      height: 2rem;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    closeButton.addEventListener('click', this.props.onClose);

    header.appendChild(title);
    header.appendChild(closeButton);

    // Content area
    const content = document.createElement('div');
    content.className = 'thread-content';
    content.id = `thread-content-${this.props.postId}`;

    // Loading state
    const loading = document.createElement('div');
    loading.className = 'thread-loading';
    loading.textContent = t('thread_view.loading');
    loading.style.cssText = `
      color: #94a3b8;
      font-family: 'Noto Sans', monospace, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
      padding: 2rem;
    `;

    container.appendChild(header);
    container.appendChild(content);
    container.appendChild(loading);

    return container;
  }

  private async loadThread(): Promise<void> {
    const content = this.element.querySelector('.thread-content') as HTMLElement;
    const loading = this.element.querySelector('.thread-loading') as HTMLElement;

    try {
      const response = await fetch(`/api/posts/${this.props.postId}/thread`);
      if (!response.ok) {
        throw new Error('Failed to load thread');
      }

      const data = (await response.json()) as { root: Post; replies: Post[] };

      // Clear loading state
      loading.style.display = 'none';

      // Create root post card
      this.rootPostCard = createPostCard({
        post: data.root,
        sandboxOrigin: this.props.sandboxOrigin,
        currentUser: this.props.currentUser || undefined,
        depth: data.root.depth,
        onDelete: () => {}, // Add empty onDelete handler to prevent errors
      });
      content.appendChild(this.rootPostCard.getElement());

      // Build reply tree
      const replyTree = buildTree(data.replies);

      // Render reply nodes
      replyTree.forEach((node) => {
        const replyNode = createReplyNode({
          node,
          sandboxOrigin: this.props.sandboxOrigin,
          currentUser: this.props.currentUser || undefined,
          onReplyCreated: (newReply) => this.handleReplyCreated(newReply),
        });
        this.replyNodes.push(replyNode);
        content.appendChild(replyNode.getElement());
      });
    } catch (error) {
      console.error('Failed to load thread:', error);
      loading.textContent = t('thread_view.load_failed');
      loading.style.color = '#ef4444';
    } finally {
    }
  }

  private handleReplyCreated(newReply: Post): void {
    // Increment reply count on root post
    if (this.rootPostCard) {
      this.rootPostCard.updatePost({
        reply_count: (this.rootPostCard.getReplyCount() || 0) + 1,
      });
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

    this.element.remove();
  }
}

// Factory function for easier usage
export function createThreadView(props: ThreadViewProps): ThreadView {
  return new ThreadView(props);
}
