// Legacy-compatible bridge: VersionHistoryModal.svelte owns the dialog; this
// adapter keeps `openVersionHistoryModal` for the post card adapters.

import { mountSvelteModal } from '../lib/modals/mount-modal.ts';
import VersionHistoryModalView from '../lib/svelte/VersionHistoryModal.svelte';

export interface VersionHistoryModalProps {
  postId: string;
  sandboxOrigin: string;
  currentVersionId: string | null;
  onPlay: (versionId: string | null) => void;
}

export function openVersionHistoryModal(props: VersionHistoryModalProps): void {
  mountSvelteModal(
    VersionHistoryModalView,
    (destroy) => ({
      postId: props.postId,
      sandboxOrigin: props.sandboxOrigin,
      currentVersionId: props.currentVersionId,
      onPlay: props.onPlay,
      onClose: destroy,
    }),
    { appendToBody: true },
  );
}
