// Desktop left-nav resize handle (split out of LeftNav.ts).
//
// A fixed-position separator sits on the nav's right edge. Dragging it resizes
// the rail; dropping below the icon threshold snaps to the compact icon rail.
// The width is written to a CSS variable on <html> so every nav instance (app
// shell + thread page) shares it and inline styles set by the thread page
// cannot wipe it.

import { t } from './i18n.js';
import {
  LEFT_NAV_ICON_WIDTH,
  LEFT_NAV_WIDTH_MAX,
  LEFT_NAV_WIDTH_MIN,
  LEFT_NAV_WIDTH_VAR,
  type LeftNavWidth,
  readLeftNavWidth,
  resolveLeftNavWidth,
  writeLeftNavWidth,
} from './left-nav-layout.js';

const HANDLE_WIDTH = 6;
const KEYBOARD_STEP = 10;
const ICONS_CLASS = 'left-nav--icons';
const RESIZING_CLASS = 'left-nav--resizing';
const RESIZE_CURSOR_CLASS = 'left-nav-resizing';

function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.innerWidth > 1024;
}

function positionHandle(nav: HTMLElement, handle: HTMLElement): void {
  const rect = nav.getBoundingClientRect();
  handle.style.top = `${rect.top}px`;
  handle.style.height = `${rect.height}px`;
  handle.style.left = `${rect.right - HANDLE_WIDTH}px`;
}

function applyWidth(nav: HTMLElement, handle: HTMLElement, raw: number): LeftNavWidth {
  const resolved = resolveLeftNavWidth(raw);
  document.documentElement.style.setProperty(LEFT_NAV_WIDTH_VAR, `${resolved.width}px`);
  nav.classList.toggle(ICONS_CLASS, resolved.icons);
  handle.setAttribute('aria-valuenow', String(resolved.width));
  positionHandle(nav, handle);
  return resolved;
}

/**
 * Attach the desktop resize separator to a left nav. Returns a cleanup
 * function; calling it removes the handle and every listener.
 */
export function setupLeftNavResize(nav: HTMLElement): () => void {
  if (!isDesktop()) return () => {};

  const handle = document.createElement('div');
  handle.className = 'nav-resize-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', t('nav.resize_handle'));
  handle.setAttribute('aria-valuemin', String(LEFT_NAV_ICON_WIDTH));
  handle.setAttribute('aria-valuemax', String(LEFT_NAV_WIDTH_MAX));
  handle.tabIndex = 0;
  nav.appendChild(handle);

  let current = applyWidth(nav, handle, readLeftNavWidth());
  const persist = (): void => writeLeftNavWidth(current.width);

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = current.width;
    nav.classList.add(RESIZING_CLASS);
    document.body.classList.add(RESIZE_CURSOR_CLASS);
    handle.setPointerCapture(event.pointerId);

    const onPointerMove = (moveEvent: PointerEvent): void => {
      current = applyWidth(nav, handle, startWidth + (moveEvent.clientX - startX));
    };
    const finish = (upEvent: PointerEvent): void => {
      if (handle.hasPointerCapture(upEvent.pointerId)) {
        handle.releasePointerCapture(upEvent.pointerId);
      }
      nav.classList.remove(RESIZING_CLASS);
      document.body.classList.remove(RESIZE_CURSOR_CLASS);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      persist();
    };

    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 1 : KEYBOARD_STEP;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') {
      next = current.icons ? current.width : current.width - step;
      // Stepping below the normal minimum collapses straight to the icon rail.
      if (!current.icons && next < LEFT_NAV_WIDTH_MIN) next = LEFT_NAV_ICON_WIDTH;
    } else if (event.key === 'ArrowRight') {
      next = current.icons ? LEFT_NAV_WIDTH_MIN : current.width + step;
    } else if (event.key === 'Home') {
      next = LEFT_NAV_ICON_WIDTH;
    } else if (event.key === 'End') {
      next = LEFT_NAV_WIDTH_MAX;
    }
    if (next === null) return;
    event.preventDefault();
    current = applyWidth(nav, handle, next);
    persist();
  };

  const onWindowResize = (): void => {
    if (!nav.isConnected) {
      cleanup();
      return;
    }
    positionHandle(nav, handle);
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onWindowResize);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => positionHandle(nav, handle));
    resizeObserver.observe(nav);
  }

  function cleanup(): void {
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onWindowResize);
    resizeObserver?.disconnect();
    handle.remove();
    nav.classList.remove(RESIZING_CLASS);
    document.body.classList.remove(RESIZE_CURSOR_CLASS);
  }

  return cleanup;
}
