// Pure swipe classification for the Arcade viewport. Keeping the thresholds
// here lets the Svelte page share one implementation between touch and mouse.

export type SwipeDirection = 'next' | 'previous' | 'reset';

export interface SwipeInput {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** Pixels per millisecond, positive downwards. */
  velocity: number;
  minDistance?: number;
  minVelocity?: number;
}

export function resolveSwipe(input: SwipeInput): SwipeDirection {
  const minDistance = input.minDistance ?? 30;
  const minVelocity = input.minVelocity ?? 0.3;
  const diffY = input.startY - input.endY;
  const diffX = input.startX - input.endX;

  if (Math.abs(diffY) > minDistance || Math.abs(input.velocity) > minVelocity) {
    if (Math.abs(diffY) > Math.abs(diffX)) {
      // A flick up (negative velocity) still means "next".
      if (diffY > 0 || input.velocity < -minVelocity) return 'next';
      return 'previous';
    }
    return 'reset';
  }
  return 'reset';
}
