import { openPostComposerModal } from '@/components/client/PostComposerModal';
import type { Post } from '@/types/post';

export function openPostModal(opts: {
  currentUser: { username: string; id?: string; display_name?: string; avatar_key?: string } | null | undefined;
  onPostCreated: (post: Post) => void;
}): void {
  openPostComposerModal({
    currentUser: opts.currentUser,
    onPostCreated: opts.onPostCreated,
  });
}
