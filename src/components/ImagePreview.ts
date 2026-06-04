import { safeRemoveFromBody } from '../lib/dom-utils.js';
import { t } from '../lib/i18n.js';
import { registerModal } from '../lib/modal-state.js';
import { GifPreviewProps } from '../types/post.js';

export function createImagePreview(props: GifPreviewProps): HTMLElement {
  const container = document.createElement('div');
  container.className = 'image-preview';

  if (!props.gifKey) {
    // Fallback for posts without image
    const fallback = document.createElement('div');
    fallback.className = 'image-preview-error';
    fallback.textContent = t('image_preview.no_preview');
    container.appendChild(fallback);
    return container;
  }

  const imageUrl = props.isThumbnail ? `/api/thumbnail/${props.postId}` : `/api/images/${props.gifKey}`;

  const img = document.createElement('img');
  img.className = 'image-preview-img';
  img.alt = t('image_preview.post_preview', { id: props.postId });
  img.loading = 'lazy';

  // Add click handler for overlay display
  img.onclick = (e) => {
    e.stopPropagation();
    createImageOverlay(imageUrl, props.postId);
  };

  // Override CSS default positioning for non-thumbnails
  if (!props.isThumbnail) {
    container.style.cssText = `
      position: relative;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      background: var(--bg-input);
      border-radius: 8px;
    `;
  }

  if (props.isThumbnail) {
    // Thumbnail: fill parent's fixed aspect ratio (set by .post-stage--image-thumb)
    img.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: cover;
      cursor: pointer;
      display: block;
    `;
    img.src = imageUrl;
    container.appendChild(img);
  } else {
    // Full image: fit within container while preserving aspect ratio
    img.style.cssText = `
      width: 100%;
      max-height: 500px;
      object-fit: scale-down;
      cursor: pointer;
      display: block;
      border-radius: 8px;
    `;

    // Show a placeholder with the same styling before load
    const placeholder = document.createElement('div');
    placeholder.className = 'image-preview-loading';
    placeholder.style.cssText = `
      width: 100%;
      padding-bottom: 56.25%;
      background: var(--bg-input);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      font-family: monospace;
      font-size: 0.875rem;
    `;
    placeholder.textContent = t('common.loading');

    img.onload = () => {
      placeholder.style.display = 'none';
    };
    img.onerror = () => {
      placeholder.style.display = 'none';
      const fallback = document.createElement('div');
      fallback.className = 'image-preview-error';
      fallback.style.cssText = `
        width: 100%;
        padding-bottom: 56.25%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-secondary);
        color: var(--text-muted);
        font-size: 0.875rem;
        text-align: center;
        padding: 2rem;
        border-radius: 8px;
      `;
      fallback.textContent = t('image_preview.load_failed');
      container.appendChild(fallback);
    };

    img.src = imageUrl;
    container.appendChild(placeholder);
    container.appendChild(img);
  }

  return container;
}

// Create image overlay modal
function createImageOverlay(imageUrl: string, postId: string): void {
  // Create overlay container
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    cursor: pointer;
  `;

  // Create image container
  const imageContainer = document.createElement('div');
  imageContainer.style.cssText = `
    width: 90vw;
    height: 90vh;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  `;

  // Create full-size image
  const fullImage = document.createElement('img');
  fullImage.src = imageUrl;
  fullImage.alt = t('image_preview.post_full_size', { id: postId });
  fullImage.style.cssText = `
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  `;

  // Create close button
  const closeButton = document.createElement('button');
  closeButton.textContent = t('image_preview.close');
  closeButton.style.cssText = `
    position: absolute;
    top: 8px;
    right: 0;
    background: rgba(255, 255, 255, 0.2);
    border: none;
    color: white;
    font-size: 24px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s ease;
  `;

  closeButton.onmouseover = () => (closeButton.style.background = 'rgba(255, 255, 255, 0.3)');
  closeButton.onmouseout = () => (closeButton.style.background = 'rgba(255, 255, 255, 0.2)');

  // Close handlers
  const unregister = registerModal();
  const closeOverlay = () => {
    unregister();
    safeRemoveFromBody(overlay);
  };

  closeButton.onclick = (e) => {
    e.stopPropagation();
    closeOverlay();
  };

  overlay.onclick = (e) => {
    if (e.target === overlay) {
      closeOverlay();
    }
  };

  // Handle ESC key
  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeOverlay();
      document.removeEventListener('keydown', handleEsc);
    }
  };
  document.addEventListener('keydown', handleEsc);

  // Assemble overlay
  imageContainer.appendChild(fullImage);
  imageContainer.appendChild(closeButton);
  overlay.appendChild(imageContainer);

  // Add to body
  document.body.appendChild(overlay);
}

// Legacy export for backward compatibility
export function createGifPreview(props: GifPreviewProps): HTMLElement {
  return createImagePreview(props);
}
