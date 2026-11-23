// Pure interaction-event shaping for Arcade recommendations.
//
// The network flush lives in `events.ts`; this module stays importable from
// Node tests and owns the payload rules (skip detection, velocity, dwell).

export interface ArcadeEvent {
  postId: string;
  position: number;
  eventType: 'view' | 'fresh' | 'reply' | 'fullscreen' | 'share';
  dwellMs: number;
  swipeVelocity: number;
  didSkip: number;
  isFullscreen: number;
  gameType: string;
}

export interface ArcadeEventInput {
  postId: string;
  eventType: ArcadeEvent['eventType'];
  dwellMs: number;
  isFullscreen: number;
  gameType: string;
  position: number;
  swipeVelocity: number;
}

/** A view shorter than two seconds counts as a skip signal. */
export function viewSkipFlag(dwellMs: number): 0 | 1 {
  return dwellMs < 2000 ? 1 : 0;
}

export function createArcadeEvent(input: ArcadeEventInput): ArcadeEvent {
  return {
    postId: input.postId,
    position: Math.max(0, Math.round(input.position)),
    eventType: input.eventType,
    dwellMs: Math.max(0, Math.round(input.dwellMs)),
    swipeVelocity: Math.abs(input.swipeVelocity),
    didSkip: input.eventType === 'view' ? viewSkipFlag(input.dwellMs) : 0,
    isFullscreen: input.isFullscreen ? 1 : 0,
    gameType: input.gameType,
  };
}

/** Long dwells are a recommendation source; refresh the vault profile. */
export function shouldRefreshProfile(events: ReadonlyArray<Pick<ArcadeEvent, 'dwellMs'>>): boolean {
  return events.some((event) => event.dwellMs > 5000);
}
