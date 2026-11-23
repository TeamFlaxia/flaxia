// Batched Arcade interaction events. The pure shaping rules live in
// `events-core.ts`; this module owns the session, timer and keepalive flush.
import type { Game } from '../../types/game.js';
import { markRecommendationProfileDirty } from '../vault/recommendation-profile.js';
import { type ArcadeEvent, createArcadeEvent, shouldRefreshProfile } from './events-core.ts';

interface TrackerOptions {
  fetchImpl?: typeof fetch;
  /** Milliseconds between flushes; production uses 5s. */
  flushIntervalMs?: number;
}

export class ArcadeEventTracker {
  readonly sessionId: string;
  entryTime = 0;
  entryFullscreen = false;

  private readonly fetchImpl: typeof fetch;
  private readonly flushIntervalMs: number;
  private readonly pending: ArcadeEvent[] = [];
  private timer: number | null = null;
  private destroyed = false;

  constructor(options: TrackerOptions = {}) {
    this.sessionId = crypto.randomUUID();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
    window.addEventListener('beforeunload', this.handleUnload);
  }

  markEntry(fullscreen: boolean): void {
    this.entryTime = performance.now();
    this.entryFullscreen = fullscreen;
  }

  recordView(game: Game, position: number, swipeVelocity: number): void {
    if (!this.entryTime || this.destroyed) return;
    const dwellMs = performance.now() - this.entryTime;
    this.push(game, 'view', position, swipeVelocity, dwellMs, this.entryFullscreen);
    this.entryTime = 0;
  }

  push(
    game: Game,
    eventType: ArcadeEvent['eventType'],
    position: number,
    swipeVelocity: number,
    dwellMs = this.entryTime ? performance.now() - this.entryTime : 0,
    fullscreen = this.entryFullscreen,
  ): void {
    if (this.destroyed) return;
    this.pending.push(
      createArcadeEvent({
        postId: game.postId,
        eventType,
        dwellMs,
        isFullscreen: fullscreen ? 1 : 0,
        gameType: game.type,
        position,
        swipeVelocity,
      }),
    );
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const response = await this.fetchImpl('/api/games/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        keepalive: true,
        body: JSON.stringify({ sessionId: this.sessionId, events: batch }),
      });
      if (response.ok && shouldRefreshProfile(batch)) {
        markRecommendationProfileDirty();
      }
    } catch {
      // Interaction data is non-critical.
    }
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('beforeunload', this.handleUnload);
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    void this.flush();
  }

  private readonly handleUnload = (): void => {
    void this.flush();
  };

  private scheduleFlush(): void {
    if (this.timer !== null || this.destroyed) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }
}
