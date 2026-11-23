// Pure helpers behind the Arcade feed. Network orchestration and vault access
// live in `feed.ts`; the rules that decide URLs, ranking and de-duplication
// stay dependency-light so they can be unit tested.
import {
  decodeVector,
  type EncodedVector,
  RECOMMENDATION_VECTOR_DIM,
} from '../../../shared/recommendation/vector-codec.ts';
import type { Game } from '../../types/game.js';
import { rankCandidates } from '../recommendation/rank.ts';

export { type ArcadeEvent, createArcadeEvent, shouldRefreshProfile, viewSkipFlag } from './events-core.ts';
export { resolveSwipe, type SwipeDirection } from './swipe.ts';

export interface GamesResponse {
  games?: Game[];
  hasMore?: boolean;
  token?: string;
  offset?: number;
  vectors?: Record<string, EncodedVector>;
  vector_meta?: { dim?: number };
  base_scores?: Record<string, number>;
}

export interface RankOptions {
  /** Decrypted preference vector, or null when the vault is locked. */
  profile?: readonly number[] | null;
  /** Deep-linked game to put first after ranking. */
  initialGameId?: string;
  promoteInitial?: boolean;
}

export function buildInitialGamesUrl(options: {
  signedIn: boolean;
  clientRank?: boolean;
  initialGameId?: string;
  limit?: number;
}): string {
  let url = options.signedIn ? '/api/games?recommended=true' : '/api/games?shuffle=true';
  if (options.clientRank) {
    url += `&client_rank=1&include_vectors=1&limit=${options.limit ?? 200}`;
  }
  if (options.initialGameId) {
    url += `&initialId=${encodeURIComponent(options.initialGameId)}`;
  }
  return url;
}

export function buildMoreGamesUrl(options: {
  signedIn: boolean;
  clientRank?: boolean;
  shuffleToken?: string | null;
  shuffleOffset?: number;
  recommendedOffset?: number;
  limit?: number;
}): string {
  if (options.signedIn && !options.shuffleToken) {
    let url = `/api/games?recommended=true&offset=${options.recommendedOffset ?? 0}`;
    if (options.clientRank) {
      url += `&client_rank=1&include_vectors=1&limit=${options.limit ?? 120}`;
    }
    return url;
  }
  if (options.shuffleToken) {
    return `/api/games?shuffle=true&token=${encodeURIComponent(options.shuffleToken)}&offset=${options.shuffleOffset ?? 0}`;
  }
  return '/api/games?shuffle=true';
}

/**
 * Rank a page of candidates with the local preference vector. Without a
 * profile the server order is preserved, and a deep-linked game is promoted to
 * the front so `/arcade/[id]` always opens the requested game.
 */
export function rankGames(data: GamesResponse, options: RankOptions = {}): Game[] {
  const games = data.games ?? [];
  const profile = options.profile ?? null;
  if (!profile) return games;

  const dim = data.vector_meta?.dim ?? RECOMMENDATION_VECTOR_DIM;
  const vectors = new Map<string, number[]>();
  for (const [postId, encoded] of Object.entries(data.vectors ?? {})) {
    const vector = decodeVector(encoded, dim);
    if (vector) vectors.set(postId, vector);
  }

  const ranked = rankCandidates({
    items: games,
    profile,
    getVector: (game) => vectors.get(game.postId) ?? null,
    getBaseScore: (game) => data.base_scores?.[game.postId] ?? 0,
    getAuthor: (game) => game.username,
    limit: games.length,
  });

  if (options.promoteInitial !== false && options.initialGameId) {
    const index = ranked.findIndex((game) => game.postId === options.initialGameId);
    if (index > 0) ranked.unshift(...ranked.splice(index, 1));
  }
  return ranked;
}

/** Append a page to the current list, skipping removed and duplicate posts. */
export function mergeGamePage(
  existing: readonly Game[],
  incoming: readonly Game[],
  missing: ReadonlySet<string>,
): { games: Game[]; added: number } {
  const games = [...existing];
  const seen = new Set(games.map((game) => game.postId));
  let added = 0;
  for (const game of incoming) {
    if (missing.has(game.postId) || seen.has(game.postId)) continue;
    games.push(game);
    seen.add(game.postId);
    added += 1;
  }
  return { games, added };
}
