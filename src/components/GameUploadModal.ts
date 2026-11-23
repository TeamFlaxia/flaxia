// Legacy-compatible bridge: GameUploadModal.svelte owns the dialog; this class
// keeps the `new GameUploadModal({...})` call site in Arcade unchanged.

import { mountSvelteModal } from '../lib/modals/mount-modal.ts';
import GameUploadModalView from '../lib/svelte/GameUploadModal.svelte';

export interface GameUploadModalProps {
  onUploaded: (postId: string) => void;
  /** Plan-aware per-file ceiling; the server enforces the same value. */
  maxUploadBytes?: number;
}

export class GameUploadModal {
  constructor(props: GameUploadModalProps) {
    mountSvelteModal(
      GameUploadModalView,
      (destroy) => ({
        onUploaded: props.onUploaded,
        maxUploadBytes: props.maxUploadBytes,
        onClose: destroy,
      }),
      { appendToBody: true },
    );
  }
}
