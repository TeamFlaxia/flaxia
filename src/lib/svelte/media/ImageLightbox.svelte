<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onDestroy, onMount } from 'svelte';
import { t } from '../../../lib/i18n.ts';
import { getTabbableElements } from '../../../lib/modal-overlay.ts';
import { registerModal } from '../../../lib/modal-state.ts';
import { nativeApiHref } from '../../../lib/native-api.ts';
import { setOfflineImage } from '../../../lib/offline-image.ts';

interface Props {
  imageUrl: string;
  postId: string;
  gallery?: string[];
  galleryIndex?: number;
  /** Adapter runs the exit animation and unmounts the component. */
  onClose: () => void;
}

let { imageUrl, postId, gallery, galleryIndex = 0, onClose }: Props = $props();

const MIN_SCALE = 1;
const MAX_SCALE = 5;

let root: HTMLDivElement;
let stageEl: HTMLDivElement;
let zoomEl: HTMLDivElement;
let img: HTMLImageElement;

let scale = $state(1);
let translateX = $state(0);
let translateY = $state(0);
let imgW = $state(0);
let imgH = $state(0);
let containerW = 0;
let containerH = 0;
let visible = $state(false);
let closing = false;

const hasGallery = $derived(!!gallery && gallery.length > 1);
let currentIndex = $state(hasGallery ? Math.min(Math.max(galleryIndex, 0), (gallery?.length || 1) - 1) : 0);
let currentUrl = $state(imageUrl);
let counter = $derived(`${currentIndex + 1} / ${gallery?.length || 1}`);
let zoomStyle = $derived(
  `transform: translate(${translateX.toFixed(1)}px, ${translateY.toFixed(1)}px) scale(${scale.toFixed(4)})`,
);

let previouslyFocused: HTMLElement | null = null;
let unregister: (() => void) | null = null;

function applyTransform(): void {
  // The derived style re-renders on state change; this hook keeps cursor
  // affordances in sync without duplicating transform math in markup.
  if (zoomEl) zoomEl.style.cursor = scale > 1 ? 'grab' : 'default';
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
}

function initImage(): void {
  if (!stageEl) return;
  containerW = stageEl.clientWidth;
  containerH = stageEl.clientHeight;
  if (!img?.naturalWidth || !img.naturalHeight || !containerW || !containerH) return;
  const imgAspect = img.naturalWidth / img.naturalHeight;
  const cAspect = containerW / containerH;
  if (imgAspect > cAspect) {
    imgW = containerW;
    imgH = containerW / imgAspect;
  } else {
    imgH = containerH;
    imgW = containerH * imgAspect;
  }
  visible = true;
  centerImage();
}

// Hide and collapse the currently decoded frame so the previous image does
// not linger while the next one is being fetched/decoded.
function clearImage(): void {
  imgW = 0;
  imgH = 0;
  visible = false;
}

function onImageLoad(): void {
  initImage();
}

function onImageError(): void {
  clearImage();
}

function requestClose(): void {
  if (closing) return;
  closing = true;
  onClose();
}

function resetZoom(): void {
  scale = 1;
  translateX = 0;
  translateY = 0;
  applyTransform();
}

function showIndex(next: number): void {
  if (!hasGallery || !gallery) return;
  currentIndex = (next + gallery.length) % gallery.length;
  resetZoom();
  clearImage();
  currentUrl = nativeApiHref(`/api/images/${gallery[currentIndex]}`);
  setOfflineImage(img, currentUrl);
  if (img.complete && img.naturalWidth > 0) initImage();
}

// Touch state
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

function onTouchStart(e: TouchEvent): void {
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
}

function onTouchMove(e: TouchEvent): void {
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
    const rect = stageEl.getBoundingClientRect();
    const cx = midX - rect.left;
    const cy = midY - rect.top;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale * (dist / pinchStartDist)));
    const ratio = newScale / pinchStartScale;
    translateX = cx - (cx - pinchStartTx) * ratio;
    translateY = cy - (cy - pinchStartTy) * ratio;
    scale = newScale;
    clampTranslation();
    applyTransform();
  }
}

function onTouchEnd(e: TouchEvent): void {
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
        const rect = stageEl.getBoundingClientRect();
        handleZoom(2.5, tapX - rect.left, tapY - rect.top);
      }
      lastTapTime = 0;
    } else {
      lastTapTime = now;
      lastTapX = tapX;
      lastTapY = tapY;
    }
  }
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
  applyTransform();
}

function onTouchCancel(): void {
  isDragging = false;
  pinching = false;
}

function onWheel(e: WheelEvent): void {
  if (imgW === 0) return;
  e.preventDefault();
  const rect = stageEl.getBoundingClientRect();
  const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
  handleZoom(scale * factor, e.clientX - rect.left, e.clientY - rect.top);
}

// Mouse drag panning
let mouseDownX = 0;
let mouseDownY = 0;
let mouseDownTx = 0;
let mouseDownTy = 0;
let mouseDragging = false;

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0 || scale <= 1 || imgW === 0) return;
  e.preventDefault();
  mouseDragging = true;
  mouseDownX = e.clientX;
  mouseDownY = e.clientY;
  mouseDownTx = translateX;
  mouseDownTy = translateY;
  if (zoomEl) zoomEl.style.cursor = 'grabbing';
}

function onDocMouseMove(e: MouseEvent): void {
  if (!mouseDragging) return;
  translateX = mouseDownTx + (e.clientX - mouseDownX);
  translateY = mouseDownTy + (e.clientY - mouseDownY);
  clampTranslation();
}

function onDocMouseUp(): void {
  if (!mouseDragging) return;
  mouseDragging = false;
  applyTransform();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    requestClose();
    return;
  }
  if (e.key === 'Tab') {
    trapFocus(e);
    return;
  }
  if (!hasGallery) return;
  if (e.key === 'ArrowLeft') {
    e.stopPropagation();
    showIndex(currentIndex - 1);
  } else if (e.key === 'ArrowRight') {
    e.stopPropagation();
    showIndex(currentIndex + 1);
  }
}

function trapFocus(e: KeyboardEvent): void {
  const tabbables = getTabbableElements(root);
  if (tabbables.length === 0) {
    e.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  const active = document.activeElement;
  const activeIndex = active instanceof HTMLElement ? tabbables.indexOf(active) : -1;
  if (activeIndex === -1) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (!e.shiftKey && activeIndex === tabbables.length - 1) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && activeIndex === 0) {
    e.preventDefault();
    last.focus();
  }
}

onMount(() => {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  unregister = registerModal();

  setOfflineImage(img, currentUrl);
  if (img.complete && img.naturalWidth > 0) initImage();
  else clearImage();

  zoomEl.addEventListener('touchstart', onTouchStart, { passive: false });
  zoomEl.addEventListener('touchmove', onTouchMove, { passive: false });
  zoomEl.addEventListener('touchend', onTouchEnd);
  zoomEl.addEventListener('touchcancel', onTouchCancel);
  zoomEl.addEventListener('wheel', onWheel, { passive: false });
  zoomEl.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);
  document.addEventListener('keydown', onKeyDown);
  applyTransform();

  root.focus({ preventScroll: true });
  // The image may have finished loading before layout was available.
  requestAnimationFrame(() => {
    if (img.complete && img.naturalWidth > 0) initImage();
  });

  return () => {
    zoomEl.removeEventListener('touchstart', onTouchStart);
    zoomEl.removeEventListener('touchmove', onTouchMove);
    zoomEl.removeEventListener('touchend', onTouchEnd);
    zoomEl.removeEventListener('touchcancel', onTouchCancel);
    zoomEl.removeEventListener('wheel', onWheel);
    zoomEl.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup', onDocMouseUp);
    document.removeEventListener('keydown', onKeyDown);
    unregister?.();
    unregister = null;
  };
});

onDestroy(() => {
  if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
  previouslyFocused = null;
});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  bind:this={root}
  class="fx-lightbox"
  role="dialog"
  aria-modal="true"
  aria-label={t('image_preview.post_full_size', { id: postId })}
  tabindex="-1"
  onclick={(e) => {
    if (e.target === root) requestClose();
  }}
>
  <div bind:this={stageEl} class="fx-lightbox__stage">
    <div bind:this={zoomEl} class="fx-lightbox__zoom" style={zoomStyle}>
      <img
        bind:this={img}
        class="fx-lightbox__img"
        alt={t('image_preview.post_full_size', { id: postId })}
        draggable="false"
        style:visibility={visible ? 'visible' : 'hidden'}
        style:width={`${imgW}px`}
        style:height={`${imgH}px`}
        onload={onImageLoad}
        onerror={onImageError}
      />
    </div>
  </div>

  <button
    type="button"
    class="fx-lightbox__close"
    aria-label={t('common.close')}
    onclick={(e) => {
      e.stopPropagation();
      requestClose();
    }}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="18" y1="6" x2="6" y2="18"></line>
      <line x1="6" y1="6" x2="18" y2="18"></line>
    </svg>
  </button>

  {#if hasGallery}
    <button
      type="button"
      class="fx-lightbox__nav fx-lightbox__nav--prev"
      aria-label="Previous image"
      onclick={(e) => {
        e.stopPropagation();
        showIndex(currentIndex - 1);
      }}>‹</button
    >
    <button
      type="button"
      class="fx-lightbox__nav fx-lightbox__nav--next"
      aria-label="Next image"
      onclick={(e) => {
        e.stopPropagation();
        showIndex(currentIndex + 1);
      }}>›</button
    >
    <div class="fx-lightbox__counter">{counter}</div>
  {/if}
</div>
