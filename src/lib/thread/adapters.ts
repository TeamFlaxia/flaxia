// Adapters around legacy reply factories for the Svelte thread page.
import type { Post } from '../../../shared/types/post.ts';
import { createPostCard } from '../../components/PostCard.ts';
import { createReplyComposer } from '../../components/ReplyComposer.ts';
import { createReplyNode } from '../../components/ReplyNode.ts';
import { updateMetaTags } from '../seo-meta.ts';
import { buildTree, type PostNode } from '../thread.ts';

export { buildTree, type PostNode };

export function mountReplyNode(
  host: HTMLElement,
  options: {
    node: PostNode;
    sandboxOrigin: string;
    currentUser?: Record<string, unknown> | null;
    postIndexMap?: Map<string, number>;
    onReplyCreated: (reply: Post) => void;
  },
): { destroy: () => void } {
  const node = createReplyNode(options as never);
  host.replaceChildren(node.getElement());
  return { destroy: () => node.destroy() };
}

export function mountThreadPostCard(
  host: HTMLElement,
  options: {
    post: Post;
    sandboxOrigin: string;
    currentUser?: Record<string, unknown> | null;
    index?: number;
    onDelete?: (id: string) => void;
    /** Flat reply lists must not navigate away on card click. */
    disableNavigation?: boolean;
  },
): { element: HTMLElement; update: (p: Partial<Post>) => void; destroy: () => void } {
  const card = createPostCard({
    post: options.post,
    sandboxOrigin: options.sandboxOrigin,
    currentUser: options.currentUser as never,
    disableReplyComposer: true,
    disableNavigation: options.disableNavigation ?? false,
    postIndex: options.index,
    enablePostRefs: true,
    onDelete: options.onDelete ?? (() => {}),
  });
  host.replaceChildren(card.getElement());
  return { element: host, update: (p) => card.updatePost(p), destroy: () => card.destroy() };
}

export function mountReplyComposer(
  host: HTMLElement,
  options: {
    postId: string;
    sandboxOrigin: string;
    onReplyCreated: (reply: Post) => void;
    onCancel: () => void;
    currentUser?: Record<string, unknown> | null;
  },
): { element: HTMLElement; focus: () => void; destroy: () => void } {
  const composer = createReplyComposer(options as never);
  host.replaceChildren(composer.getElement());
  return { element: host, focus: () => composer.focus(), destroy: () => composer.destroy() };
}

export function updateThreadMeta(post: Post): void {
  updateMetaTags({
    title: `Flaxia - @${post.username}`,
    description: (post.text || '').slice(0, 120) || 'Flaxia thread',
    url: `${typeof window !== 'undefined' ? window.location.origin : ''}/thread/${post.id}`,
  });
}
