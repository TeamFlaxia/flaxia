import type { Game } from '../types/game.js';
import { nativeApiHref } from './native-api.js';
import { createWvfsGameUrl } from './wvfs-game-url.js';

/** Check the entry document that will actually be loaded in the game frame. */
export async function isArcadeGameAvailable(game: Game, sandboxOrigin: string, signal?: AbortSignal): Promise<boolean> {
  const url =
    game.type === 'zip'
      ? createWvfsGameUrl(sandboxOrigin, game.postId)
      : nativeApiHref(`/api/games/html5/${encodeURIComponent(game.id)}`);
  try {
    const timeout = AbortSignal.timeout(10_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, { method: 'HEAD', mode: 'cors', cache: 'no-store', signal: requestSignal });
    return response.status !== 404 && response.status !== 410;
  } catch (error) {
    if (signal?.aborted) throw error;
    // A network failure does not establish that a game has been removed.
    return true;
  }
}

/** Remove missing entries, advancing through server pages until one is playable. */
export async function findAvailableArcadeGame(
  games: Game[],
  startIndex: number,
  options: {
    isAvailable: (game: Game) => Promise<boolean>;
    loadMore: () => Promise<boolean>;
    onMissing: (game: Game) => void;
    signal: AbortSignal;
  },
): Promise<{ game: Game; index: number } | null> {
  let index = Math.min(startIndex, games.length);
  while (true) {
    options.signal.throwIfAborted();
    if (index >= games.length) {
      const advanced = await options.loadMore();
      options.signal.throwIfAborted();
      if (advanced) continue;
      if (games.length === 0) return null;
      // At the end of the feed, retain the last available game for back navigation.
      index = games.length - 1;
    }
    const game = games[index];
    const available = await options.isAvailable(game);
    options.signal.throwIfAborted();
    if (available) return { game, index };
    games.splice(index, 1);
    options.onMissing(game);
  }
}
