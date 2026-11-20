// Legacy-compatible bridge: Svelte owns the quoted card DOM.
import { type Component, mount, unmount } from 'svelte';
import type { QuotedPost } from '../../shared/types/post.ts';
import QuotedPostCardView from '../lib/svelte/QuotedPostCard.svelte';

export interface QuotedPostCardProps {
  quoted: QuotedPost | null;
  disableNavigation?: boolean;
  onNavigateToThread: (postId: string) => void;
}

export function createQuotedPostCard(props: QuotedPostCardProps): HTMLElement | null {
  const target = document.createElement('div');
  const instance = mount(QuotedPostCardView as Component, { target, props });
  const element = target.firstElementChild as HTMLElement;
  element.remove();
  (element as HTMLElement & { destroy?: () => void }).destroy = () => unmount(instance as never);
  return element;
}
