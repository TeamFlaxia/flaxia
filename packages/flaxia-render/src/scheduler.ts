/**
 * Read/write scheduling helpers. DOM writes are batched at the microtask level
 * by the signal scheduler; measurements belong in `afterPaint` so a render pass
 * never interleaves reads and writes (which is what triggers layout thrashing).
 */

export function afterPaint(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
}

export function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    afterPaint(() => resolve());
  });
}

interface IdleDeadlineLike {
  didTimeout: boolean;
  timeRemaining(): number;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export function scheduleIdle(fn: () => void, timeout = 200): () => void {
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const id = idleWindow.requestIdleCallback(() => fn(), { timeout });
    return () => idleWindow.cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, 0);
  return () => clearTimeout(id);
}
