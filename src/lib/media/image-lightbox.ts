// Adapter for the Svelte lightbox: mounts into body and owns the exit
// animation, so every caller keeps a simple imperative entry point.

import type { Component } from 'svelte';
import { mount, unmount } from 'svelte';
import { safeRemoveFromBody } from '../dom-utils.ts';
import { closeWithAnimation } from '../modal-overlay.ts';
import ImageLightbox from '../svelte/media/ImageLightbox.svelte';

export function openImageLightbox(imageUrl: string, postId: string, gallery?: string[], galleryIndex = 0): void {
  const target = document.createElement('div');
  document.body.appendChild(target);

  let instance: Record<string, unknown> | null = null;
  let closed = false;

  instance = mount(ImageLightbox as Component, {
    target,
    props: {
      imageUrl,
      postId,
      gallery,
      galleryIndex,
      onClose: () => {
        if (closed) return;
        closed = true;
        const root = target.firstElementChild;
        const finish = () => {
          if (instance) unmount(instance as never);
          instance = null;
          safeRemoveFromBody(target);
        };
        if (root instanceof HTMLElement) closeWithAnimation(root, finish);
        else finish();
      },
    },
  }) as Record<string, unknown>;
}
