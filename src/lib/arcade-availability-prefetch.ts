import type { Game } from '../types/game.js';
import { isArcadeGameAvailable } from './arcade-availability.js';

const MAX_PROBES = 8;
const MAX_AVAILABLE_PROBE_AGE_MS = 120_000;
const MAX_MISSING_PROBE_AGE_MS = 10_000;

type AvailabilityProbe = {
  checkedAt?: number;
  available?: boolean;
  promise: Promise<boolean>;
};

/**
 * Share bounded, asynchronous availability checks between the active game and
 * the next two Arcade items. A HEAD preflight can finish while the previous
 * game is being played instead of serially blocking every swipe.
 *
 * Successful checks are reused briefly to cover normal game sessions. Missing
 * results are rechecked sooner, and the sandbox still enforces the current
 * publication gate on every GET.
 */
export class ArcadeAvailabilityPrefetch {
  private readonly probes = new Map<string, AvailabilityProbe>();
  private readonly controller = new AbortController();
  private readonly sandboxOrigin: string;
  private destroyed = false;

  constructor(sandboxOrigin: string) {
    this.sandboxOrigin = sandboxOrigin;
  }

  prefetch(game: Game): Promise<boolean> {
    if (this.destroyed) return Promise.resolve(true);
    const key = `${game.type}:${game.postId}:${game.id}`;
    const existing = this.probes.get(key);
    if (existing) {
      const maxAge = existing.available === false ? MAX_MISSING_PROBE_AGE_MS : MAX_AVAILABLE_PROBE_AGE_MS;
      if (existing.checkedAt === undefined || Date.now() - existing.checkedAt < maxAge) {
        return existing.promise;
      }
      this.probes.delete(key);
    }

    if (this.probes.size >= MAX_PROBES) {
      const oldest = this.probes.keys().next().value;
      if (oldest !== undefined) this.probes.delete(oldest);
    }

    // A closed Arcade page must not leave a rejected speculative promise
    // unhandled. Network failures are already treated as retryable upstream.
    let probe: AvailabilityProbe;
    const check = isArcadeGameAvailable(game, this.sandboxOrigin, this.controller.signal)
      .catch((error: unknown) => {
        if (this.controller.signal.aborted) return true;
        throw error;
      })
      .then(
        (available) => {
          if (this.probes.get(key) === probe) {
            probe.checkedAt = Date.now();
            probe.available = available;
          }
          return available;
        },
        (error: unknown) => {
          if (this.probes.get(key) === probe) this.probes.delete(key);
          throw error;
        },
      );
    probe = { promise: check };
    this.probes.set(key, probe);
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
    this.destroyed = true;
    this.controller.abort();
    this.probes.clear();
  }
}
