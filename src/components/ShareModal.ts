// Legacy-compatible bridge: ShareModal.svelte owns the dialog; this adapter
// keeps `createShareModal` for the PostCard and Arcade call sites.

import { mountSvelteModal } from '../lib/modals/mount-modal.ts';
import ShareModalView from '../lib/svelte/ShareModal.svelte';

export interface ShareMedia {
  blob: Blob;
  filename: string;
}

export interface ShareModalProps {
  post: {
    id: string;
    text: string;
    username: string;
    display_name?: string;
  };
  url?: string;
  media?: ShareMedia;
  onClose: () => void;
  onQuote?: () => void;
}

export function createShareModal(props: ShareModalProps): HTMLElement {
  const { host } = mountSvelteModal(
    ShareModalView,
    (destroy) => ({
      post: props.post,
      url: props.url,
      media: props.media,
      onClose: () => {
        destroy();
        props.onClose();
      },
      onQuote: props.onQuote
        ? () => {
            props.onQuote?.();
            destroy();
          }
        : undefined,
    }),
    { appendToBody: true },
  );
  return host;
}
