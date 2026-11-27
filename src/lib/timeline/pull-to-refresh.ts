import { isModalOpen } from '../modal-state.ts';

/** Resisted distance (px) required to arm a normal pull. */
export const PULL_THRESHOLD = 64;
/** Hard cap for the resisted pull distance (px). */
export const PULL_MAX_DISTANCE = 96;

const PULL_RESISTANCE = 0.5;
const QUICK_PULL_DISTANCE = 24;
const QUICK_PULL_VELOCITY = 0.5;
/** Movement below this is finger jitter, not an intentional pull. */
const PREVENT_DEFAULT_DISTANCE = 8;
const HORIZONTAL_JITTER_TOLERANCE = 8;
/** Small native scroll drift is tolerated; a larger jump invalidates the pull. */
const SCROLL_DRIFT_TOLERANCE = 4;
/** Velocity older than this is stale and must not arm a quick flick. */
const VELOCITY_MAX_AGE = 150;
const INTERACTIVE_TARGETS =
  'input, textarea, select, [contenteditable="true"], .audio-player-seekbar, .audio-player-seekbar-row, .video-player-seekbar, .video-player-seekbar-row';

/** Resist downward drag by half, reject upward and horizontal-dominant moves. */
export function pullProgress(dy: number, dx: number): number {
  if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) return 0;
  return Math.min(dy * PULL_RESISTANCE, PULL_MAX_DISTANCE);
}

/** A long pull arms the refresh; a short pull needs a quick flick. */
export function shouldTriggerRefresh(distance: number, velocity: number): boolean {
  return distance >= PULL_THRESHOLD || (distance >= QUICK_PULL_DISTANCE && velocity >= QUICK_PULL_VELOCITY);
}

interface PullPoint {
  clientX: number;
  clientY: number;
}

interface PullTouchEvent {
  touches: readonly PullPoint[];
  target: EventTarget | null;
  preventDefault(): void;
}

interface PullGesture {
  startX: number;
  startY: number;
  lastY: number;
  lastTime: number;
  distance: number;
  velocity: number;
  refreshed: boolean;
}

type PullListener = (event: Event) => void;

function isAtScrollTop(): boolean {
  return (globalThis.window?.scrollY ?? 0) <= 0;
}

function hasScrolledAwayFromTop(): boolean {
  return (globalThis.window?.scrollY ?? 0) > SCROLL_DRIFT_TOLERANCE;
}

function monotonicNow(): number {
  const perf = globalThis.performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return (target as Element).closest(INTERACTIVE_TARGETS) !== null;
}

/**
 * Listen for a downward pull at the top of the scrolling document. The caller
 * owns the visual indicator and the refresh action; this helper only reports
 * state and decides when (and at most once) to refresh.
 */
export function setupPullToRefresh(
  root: HTMLElement,
  options: { onRefresh: () => void; onProgress?: (distance: number, armed: boolean) => void },
): () => void {
  let gesture: PullGesture | null = null;
  const passiveStart: AddEventListenerOptions = { passive: true };
  const passiveMove: AddEventListenerOptions = { passive: false };

  const report = (distance: number, armed: boolean): void => {
    options.onProgress?.(distance, armed);
  };

  const onTouchStart: PullListener = (event) => {
    if (gesture !== null || !isAtScrollTop() || isModalOpen()) return;
    if (globalThis.document?.body?.style?.overflow === 'hidden') return;

    const touchEvent = event as unknown as PullTouchEvent;
    if (touchEvent.touches.length !== 1 || isInteractiveTarget(touchEvent.target)) return;
    const touch = touchEvent.touches[0];
    if (!touch) return;

    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastY: touch.clientY,
      lastTime: monotonicNow(),
      distance: 0,
      velocity: 0,
      refreshed: false,
    };
  };

  const endGesture = (refresh: boolean): void => {
    if (gesture === null) return;
    const current = gesture;
    gesture = null;
    try {
      const velocity = monotonicNow() - current.lastTime > VELOCITY_MAX_AGE ? 0 : current.velocity;
      if (refresh && !current.refreshed && shouldTriggerRefresh(current.distance, velocity)) {
        current.refreshed = true;
        options.onRefresh();
      }
    } finally {
      report(0, false);
    }
  };

  const cancelGesture = (): void => {
    if (gesture === null) return;
    gesture.velocity = 0;
    endGesture(false);
  };

  const onTouchMove: PullListener = (event) => {
    if (gesture === null) return;

    // Eligibility was checked at touchstart; a modal, scroll lock, or real
    // scrolling that appears mid-gesture invalidates the pull.
    if (isModalOpen() || globalThis.document?.body?.style?.overflow === 'hidden' || hasScrolledAwayFromTop()) {
      cancelGesture();
      return;
    }

    const touchEvent = event as unknown as PullTouchEvent;
    if (touchEvent.touches.length !== 1) {
      cancelGesture();
      return;
    }
    const touch = touchEvent.touches[0];
    if (!touch) {
      cancelGesture();
      return;
    }

    const dy = touch.clientY - gesture.startY;
    const dx = touch.clientX - gesture.startX;
    if (dy <= 0) {
      cancelGesture();
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      if (Math.abs(dx) > HORIZONTAL_JITTER_TOLERANCE) {
        cancelGesture();
        return;
      }
      // Minor horizontal drift is noise, not a swipe: keep the gesture alive
      // but drop any velocity and recompute distance from the current point.
      // Otherwise an armed distance would survive a drag back near the start
      // and refresh on release. pullProgress returns 0 for this drift.
      gesture.velocity = 0;
      gesture.distance = pullProgress(dy, dx);
      report(gesture.distance, gesture.distance >= PULL_THRESHOLD);
      return;
    }

    const time = monotonicNow();
    const elapsed = time - gesture.lastTime;
    if (elapsed > 0) gesture.velocity = (touch.clientY - gesture.lastY) / elapsed;
    gesture.lastY = touch.clientY;
    gesture.lastTime = time;

    const distance = pullProgress(dy, dx);
    gesture.distance = distance;
    report(distance, distance >= PULL_THRESHOLD);
    if (distance >= PREVENT_DEFAULT_DISTANCE && isAtScrollTop()) touchEvent.preventDefault();
  };

  const onTouchEnd: PullListener = () => {
    endGesture(true);
  };
  const onTouchCancel: PullListener = () => {
    endGesture(false);
  };

  root.addEventListener('touchstart', onTouchStart, passiveStart);
  root.addEventListener('touchmove', onTouchMove, passiveMove);
  root.addEventListener('touchend', onTouchEnd);
  root.addEventListener('touchcancel', onTouchCancel);

  return () => {
    root.removeEventListener('touchstart', onTouchStart, passiveStart);
    root.removeEventListener('touchmove', onTouchMove, passiveMove);
    root.removeEventListener('touchend', onTouchEnd);
    root.removeEventListener('touchcancel', onTouchCancel);
    gesture = null;
  };
}
