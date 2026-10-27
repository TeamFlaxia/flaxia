import type { Game } from '../types/game.js';
import { isArcadeGameAvailable } from './arcade-availability.js';

const MAX_PROBES = 8;

/**
 * Share bounded, asynchronous availability checks between the active game and
 * the next two Arcade items. A HEAD preflight can finish while the previous
 * game is being played instead of serially blocking every swipe.
 *
 * An invalidated/blocked game still receives the same live HEAD check. We do
 * not cache results beyond this ArcadePage instance or replace publication
 * checks with client-side assumptions.
 */
export class ArcadeAvailabilityPrefetch {
  private readonly probes = new Map<string, Promise<boolean>>();
  private readonly controller = new AbortController();

  constructor(private readonly sandboxOrigin: string) {}

  prefetch(game: Game): Promise<boolean> {
    const key = `${game.type}:${game.postId}:${game.id}`;
    const existing = this.probes.get(key);
    if (existing) return existing;

    if (this.probes.size >= MAX_PROBES) {
      const oldest = this.probes.keys().next().value;
      if (oldest !== undefined) this.probes.delete(oldest);
    }

    // A closed Arcade page must not leave a rejected speculative promise
    // unhandled. Network failures are already treated as retryable upstream.
    const check = isArcadeGameAvailable(game, this.sandboxOrigin, this.controller.signal).catch((error: unknown) => {
      if (this.controller.signal.aborted) return true;
      throw error;
    });
    this.probes.set(key, check);
    return check;
  }

  async isAvailable(game: Game, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const pending = this.prefetch(game);
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (available) => {
          signal.removeEventListener('abort', onAbort);
          resolve(available);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  destroy(): void {
    this.controller.abort();
    this.probes.clear();
  }
}
