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

// Create image overlay modal with pinch-to-zoom and pan
function createImageOverlay(imageUrl: string, postId: string): void {
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

  const imageContainer = document.createElement('div');
  imageContainer.style.cssText = `
    width: 90vw;
    height: 90vh;
    position: relative;
    overflow: hidden;
  `;

  const zoomWrapper = document.createElement('div');
  zoomWrapper.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    cursor: default;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  `;

  const fullImage = document.createElement('img');
  fullImage.alt = t('image_preview.post_full_size', { id: postId });
  fullImage.draggable = false;
  fullImage.style.cssText = `
    display: block;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    pointer-events: none;
  `;

  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let imgW = 0;
  let imgH = 0;
  let containerW = 0;
  let containerH = 0;
  const MIN_SCALE = 1;
  const MAX_SCALE = 5;

  function applyTransform(): void {
    zoomWrapper.style.transform = `translate(${translateX.toFixed(1)}px, ${translateY.toFixed(1)}px) scale(${scale.toFixed(4)})`;
  }

  function centerImage(): void {
    translateX = (containerW - imgW) / 2;
    translateY = (containerH - imgH) / 2;
    applyTransform();
  }

  function clampTranslation(): void {
    if (scale <= 1) {
      centerImage();
      return;
    }
    const sw = imgW * scale;
    const sh = imgH * scale;
    const marginX = Math.max(containerW * 0.15, 40);
    const marginY = Math.max(containerH * 0.15, 40);
    const maxPanX = Math.max((sw - containerW) / 2 + marginX, 0);
    const maxPanY = Math.max((sh - containerH) / 2 + marginY, 0);
    const targetCx = containerW / 2;
    const targetCy = containerH / 2;
    const cx = translateX + sw / 2;
    const cy = translateY + sh / 2;
    translateX = Math.max(targetCx - maxPanX, Math.min(targetCx + maxPanX, cx)) - sw / 2;
    translateY = Math.max(targetCy - maxPanY, Math.min(targetCy + maxPanY, cy)) - sh / 2;
    applyTransform();
  }

  function handleZoom(newScale: number, cx: number, cy: number): void {
    newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    const ratio = newScale / scale;
    translateX = cx - (cx - translateX) * ratio;
    translateY = cy - (cy - translateY) * ratio;
    scale = newScale;
    clampTranslation();
    applyTransform();
    zoomWrapper.style.cursor = scale > 1 ? 'grab' : 'default';
  }

  function initImage(): void {
    containerW = imageContainer.clientWidth;
    containerH = imageContainer.clientHeight;
    const imgAspect = fullImage.naturalWidth / fullImage.naturalHeight;
    const cAspect = containerW / containerH;
    if (imgAspect > cAspect) {
      imgW = containerW;
      imgH = containerW / imgAspect;
    } else {
      imgH = containerH;
      imgW = containerH * imgAspect;
    }
    fullImage.style.width = `${imgW}px`;
    fullImage.style.height = `${imgH}px`;
    centerImage();
  }

  fullImage.onload = initImage;
  fullImage.src = imageUrl;
  if (fullImage.complete && fullImage.naturalWidth > 0) {
    initImage();
  }

  // Touch event state
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTx = 0;
  let touchStartTy = 0;
  let isDragging = false;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchStartTx = 0;
  let pinchStartTy = 0;
  let pinching = false;
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  function touchDist(t1: Touch, t2: Touch): number {
    return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  }

  zoomWrapper.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      e.preventDefault();
      if (imgW === 0) return;
      if (e.touches.length === 1) {
        isDragging = scale > 1;
        pinching = false;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStartTx = translateX;
        touchStartTy = translateY;
      } else if (e.touches.length === 2) {
        isDragging = false;
        pinching = true;
        pinchStartDist = touchDist(e.touches[0], e.touches[1]);
        pinchStartScale = scale;
        pinchStartTx = translateX;
        pinchStartTy = translateY;
      }
    },
    { passive: false },
  );

  zoomWrapper.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      e.preventDefault();
      if (imgW === 0) return;
      if (e.touches.length === 1 && isDragging) {
        translateX = touchStartTx + (e.touches[0].clientX - touchStartX);
        translateY = touchStartTy + (e.touches[0].clientY - touchStartY);
        clampTranslation();
      } else if (e.touches.length === 2 && pinching && pinchStartDist > 0) {
        const dist = touchDist(e.touches[0], e.touches[1]);
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const rect = imageContainer.getBoundingClientRect();
        const cx = midX - rect.left;
        const cy = midY - rect.top;
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale * (dist / pinchStartDist)));
        const ratio = newScale / pinchStartScale;
        translateX = cx - (cx - pinchStartTx) * ratio;
        translateY = cy - (cy - pinchStartTy) * ratio;
        scale = newScale;
        clampTranslation();
        zoomWrapper.style.cursor = scale > 1 ? 'grab' : 'default';
      }
    },
    { passive: false },
  );

  zoomWrapper.addEventListener('touchend', (e: TouchEvent) => {
    // Double-tap detection
    if (e.changedTouches.length === 1 && !pinching) {
      const now = Date.now();
      const tapX = e.changedTouches[0].clientX;
      const tapY = e.changedTouches[0].clientY;
      const dt = now - lastTapTime;
      const dist = Math.hypot(tapX - lastTapX, tapY - lastTapY);
      if (dt < 300 && dist < 30 && imgW > 0) {
        if (scale > 1.5) {
          handleZoom(1, containerW / 2, containerH / 2);
        } else {
          const rect = imageContainer.getBoundingClientRect();
          handleZoom(2.5, tapX - rect.left, tapY - rect.top);
        }
        lastTapTime = 0;
      } else {
        lastTapTime = now;
        lastTapX = tapX;
        lastTapY = tapY;
      }
    }
    // Handle finger count transitions
    if (e.touches.length === 0) {
      isDragging = false;
      pinching = false;
    } else if (e.touches.length === 1 && scale > 1) {
      isDragging = true;
      pinching = false;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTx = translateX;
      touchStartTy = translateY;
    } else {
      isDragging = false;
      pinching = false;
    }
    zoomWrapper.style.cursor = scale > 1 ? 'grab' : 'default';
  });

  zoomWrapper.addEventListener('touchcancel', () => {
    isDragging = false;
    pinching = false;
  });

  // Mouse wheel zoom (desktop)
  zoomWrapper.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (imgW === 0) return;
      e.preventDefault();
      const rect = imageContainer.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      handleZoom(scale * factor, cx, cy);
    },
    { passive: false },
  );

  // Mouse drag panning (desktop)
  let mouseDownX = 0;
  let mouseDownY = 0;
  let mouseDownTx = 0;
  let mouseDownTy = 0;
  let mouseDragging = false;

  zoomWrapper.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0 || scale <= 1 || imgW === 0) return;
    e.preventDefault();
    mouseDragging = true;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    mouseDownTx = translateX;
    mouseDownTy = translateY;
    zoomWrapper.style.cursor = 'grabbing';
  });

  const onMouseMove = (e: MouseEvent) => {
    if (!mouseDragging) return;
    translateX = mouseDownTx + (e.clientX - mouseDownX);
    translateY = mouseDownTy + (e.clientY - mouseDownY);
    clampTranslation();
  };

  const onMouseUp = () => {
    if (mouseDragging) {
      mouseDragging = false;
      zoomWrapper.style.cursor = scale > 1 ? 'grab' : 'default';
    }
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Close button (positioned outside the image container)
  const closeButton = document.createElement('button');
  closeButton.textContent = t('image_preview.close');
  closeButton.style.cssText = `
    position: fixed;
    top: 8px;
    right: 16px;
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
    z-index: 1001;
  `;

  closeButton.onmouseover = () => (closeButton.style.background = 'rgba(255, 255, 255, 0.3)');
  closeButton.onmouseout = () => (closeButton.style.background = 'rgba(255, 255, 255, 0.2)');

  const unregister = registerModal();
  const closeOverlay = () => {
    unregister();
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', handleEsc);
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

  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeOverlay();
    }
  };
  document.addEventListener('keydown', handleEsc);

  // Assemble
  zoomWrapper.appendChild(fullImage);
  imageContainer.appendChild(zoomWrapper);
  overlay.appendChild(imageContainer);
  overlay.appendChild(closeButton);
  document.body.appendChild(overlay);
}

// Legacy export for backward compatibility
export function createGifPreview(props: GifPreviewProps): HTMLElement {
  return createImagePreview(props);
}
