// Legacy-compatible bridge: GameUpdateModal.svelte owns the dialog; this
// adapter keeps `openGameUpdateModal` for the post card adapters.

import { mountSvelteModal } from '../lib/modals/mount-modal.ts';
import GameUpdateModalView from '../lib/svelte/GameUpdateModal.svelte';

export interface GameUpdateModalProps {
  postId: string;
  sandboxOrigin: string;
  onUpdated: () => void;
}

export function openGameUpdateModal(props: GameUpdateModalProps): void {
  mountSvelteModal(
    GameUpdateModalView,
    (destroy) => ({
      postId: props.postId,
      sandboxOrigin: props.sandboxOrigin,
      onUpdated: props.onUpdated,
      onClose: destroy,
    }),
    { appendToBody: true },
  );
}
