// Left nav width model — pure helpers shared by the resize handle and tests.
//
// The rail has two layouts: the full "normal" sidebar and a compact "icons"
// rail. Dragging below LEFT_NAV_ICON_THRESHOLD snaps to the compact rail;
// dragging back above it restores the normal layout. The chosen width is
// persisted so it survives reloads and applies to every nav instance (the app
// shell and the thread page both render a .left-nav).

export const LEFT_NAV_WIDTH_DEFAULT = 290;
export const LEFT_NAV_WIDTH_MIN = 200;
export const LEFT_NAV_WIDTH_MAX = 380;
export const LEFT_NAV_ICON_WIDTH = 72;
export const LEFT_NAV_ICON_THRESHOLD = 140;
export const LEFT_NAV_WIDTH_STORAGE_KEY = 'flaxia_left_nav_width';
export const LEFT_NAV_WIDTH_VAR = '--flaxia-nav-width';

export interface LeftNavWidth {
  width: number;
  icons: boolean;
}

export function clampLeftNavWidth(width: number): number {
  const rounded = Math.round(width);
  return Math.min(LEFT_NAV_WIDTH_MAX, Math.max(LEFT_NAV_WIDTH_MIN, rounded));
}

/** Map a raw pixel width to the closest supported layout. */
export function resolveLeftNavWidth(raw: number): LeftNavWidth {
  if (!Number.isFinite(raw)) {
    return { width: LEFT_NAV_WIDTH_DEFAULT, icons: false };
  }
  if (raw <= LEFT_NAV_ICON_THRESHOLD) {
    return { width: LEFT_NAV_ICON_WIDTH, icons: true };
  }
  return { width: clampLeftNavWidth(raw), icons: false };
}

export function readLeftNavWidth(): number {
  try {
    const stored = localStorage.getItem(LEFT_NAV_WIDTH_STORAGE_KEY);
    if (stored === null) return LEFT_NAV_WIDTH_DEFAULT;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed) || parsed <= 0) return LEFT_NAV_WIDTH_DEFAULT;
    return resolveLeftNavWidth(parsed).width;
  } catch {
    return LEFT_NAV_WIDTH_DEFAULT;
  }
}

export function writeLeftNavWidth(width: number): void {
  try {
    localStorage.setItem(LEFT_NAV_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Storage can be unavailable (private mode); resizing still works.
  }
}
