// Adapters around legacy PostCard sub-factories so the Svelte card never
// calls a create* DOM factory directly.
import type { Post, PostCardMode, PostTextProps } from '../../../shared/types/post.ts';
import { openCounterNoticeModal } from '../../components/CounterNoticeModal.js';
import { openGameUpdateModal } from '../../components/GameUpdateModal.js';
import { type ActionPop, createPostActions } from '../../components/PostActions.js';
import { createMenuButton, createPostMenuDropdown, setupMenuCloseHandler } from '../../components/PostMenu.js';
import { createPostStage, destroyPostStage, updatePostStage } from '../../components/PostStage.js';
import { createPostText } from '../../components/PostText.js';
import { createReplyComposer, type ReplyComposer } from '../../components/ReplyComposer.js';
import { openReportModal } from '../../components/ReportModal.js';
import { createShareModal } from '../../components/ShareModal.js';
import { openVersionHistoryModal } from '../../components/VersionHistoryModal.js';
import { createConfirmDialog } from '../confirm-dialog.ts';
import { loadLinkPreview } from '../link-preview.js';

export interface StageHandle {
  element: HTMLElement;
  update: (post: Post, mode: PostCardMode, versionId?: string) => void;
  destroy: () => void;
}

export function mountStage(
  host: HTMLElement,
  options: {
    post: Post;
    mode: PostCardMode;
    sandboxOrigin: string;
    versionId?: string;
    onModeChange: (mode: PostCardMode) => void;
  },
): StageHandle {
  const element = createPostStage(options);
  host.replaceChildren(element);
  return {
    element,
    update: (post, mode, versionId) => updatePostStage(element, { ...options, post, mode, versionId }),
    destroy: () => destroyPostStage(element),
  };
}

export function mountActions(host: HTMLElement, options: Parameters<typeof createPostActions>[0]): void {
  host.replaceChildren(createPostActions(options));
}

export function mountReply(host: HTMLElement, options: Parameters<typeof createReplyComposer>[0]): ReplyComposer {
  const composer = createReplyComposer(options);
  host.replaceChildren(composer.getElement());
  return composer;
}

export async function mountPostText(host: HTMLElement, props: PostTextProps): Promise<void> {
  host.replaceChildren(await createPostText(props));
}

export function mountLinkPreview(host: HTMLElement, text: string): void {
  loadLinkPreview(text, host, true);
}

export function openShare(post: Post, onQuote: () => void): void {
  document.body.appendChild(
    createShareModal({
      post: { id: post.id, text: post.text, username: post.username, display_name: post.display_name },
      onClose: () => {},
      onQuote,
    }),
  );
}

export function openReport(post: Post): void {
  openReportModal(post.id);
}

export function openCounterNotice(post: Post): void {
  openCounterNoticeModal(post.id);
}

export function openVersionHistory(
  post: Post,
  sandboxOrigin: string,
  currentVersionId: string | null,
  onPlay: (id: string | null) => void,
): void {
  openVersionHistoryModal({ postId: post.id, sandboxOrigin, currentVersionId, onPlay });
}

export function openGameUpdate(post: Post, sandboxOrigin: string, onUpdated: () => void): void {
  openGameUpdateModal({ postId: post.id, sandboxOrigin, onUpdated });
}

export function mountMenu(
  host: HTMLElement,
  options: Parameters<typeof createPostMenuDropdown>[0],
  onClose: () => void,
): void {
  const button = createMenuButton(() => {
    if (host.childElementCount > 1) {
      host.replaceChildren();
      onClose();
    } else mountMenu(host, options, onClose);
  });
  const dropdown = createPostMenuDropdown(options);
  host.replaceChildren(button, dropdown);
  setupMenuCloseHandler(dropdown, () => {
    host.replaceChildren();
    onClose();
  });
}

export function confirmDelete(): Promise<boolean> {
  return createConfirmDialog('post.delete_confirm');
}

export function mountMenuButton(host: HTMLElement, onClick: () => void): void {
  host.replaceChildren(createMenuButton(onClick));
}
