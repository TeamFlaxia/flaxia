// Adapter for the legacy title-badge DOM factory used by the Svelte post header.

import type { PostHeaderProps } from '../../../shared/types/post.ts';
import { createUserTitleBadge } from '../user-title.ts';

export function mountTitleBadge(host: HTMLElement, props: PostHeaderProps): void {
  const badge = createUserTitleBadge(props);
  if (badge) host.replaceChildren(badge);
}
