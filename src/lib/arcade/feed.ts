// Arcade feed orchestration (no DOM). The Svelte surface renders whatever this
// module exposes; availability probes and paging stay shared with the rest of
// the app.
import type { Game } from '../../types/game.js';
import { findAvailableArcadeGame } from '../arcade-availability.js';
import { ArcadeAvailabilityPrefetch } from '../arcade-availability-prefetch.js';
import { getRecommendationProfile, type RecommendationProfile } from '../vault/recommendation-profile.js';
import { buildInitialGamesUrl, buildMoreGamesUrl, type GamesResponse, mergeGamePage, rankGames } from './feed-core.ts';

export interface ArcadeFeedOptions {
  currentUser: { id: string } | null;
  initialGameId?: string;
  sandboxOrigin: string;
}

export interface ArcadeFeedSelection {
  game: Game;
  index: number;
}

export class ArcadeGameFeed {
  games: Game[] = [];
  index = 0;
  hasMore = false;
  loading = false;
  loadingMore = false;
  empty = false;

  private readonly options: ArcadeFeedOptions;
  private readonly availability: ArcadeAvailabilityPrefetch;
  private readonly missingGameIds = new Set<string>();
  private recommendedProfile: RecommendationProfile | null = null;
  private shuffleToken: string | null = null;
  private shuffleOffset = 0;
  private recommendedOffset = 0;
  private moreGamesRequest: Promise<boolean> | null = null;
  private destroyed = false;

  constructor(options: ArcadeFeedOptions) {
    this.options = options;
    this.availability = new ArcadeAvailabilityPrefetch(options.sandboxOrigin);
  }

  async loadInitial(): Promise<boolean> {
    if (this.loading) return this.games.length > 0;
    this.loading = true;
    this.empty = false;

    try {
      this.recommendedProfile = this.options.currentUser ? await getRecommendationProfile() : null;
      if (this.destroyed) return false;

      const url = buildInitialGamesUrl({
        signedIn: Boolean(this.options.currentUser),
        clientRank: Boolean(this.recommendedProfile),
        initialGameId: this.options.initialGameId,
        limit: 200,
      });
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        this.empty = true;
        return false;
      }
      const data = (await response.json()) as GamesResponse;
      if (this.destroyed) return false;

      this.games = rankGames(data, {
        profile: this.recommendedProfile?.vector ?? null,
        initialGameId: this.options.initialGameId,
        promoteInitial: true,
      }).filter((game) => !this.missingGameIds.has(game.postId));

      this.hasMore = Boolean(data.hasMore);
      this.shuffleToken = data.token ?? null;
      this.shuffleOffset = data.token ? (data.offset ?? 0) : 0;
      this.recommendedOffset = data.token ? 0 : (data.offset ?? 0);

      if (this.options.initialGameId) {
        const linked = this.games.findIndex((game) => game.postId === this.options.initialGameId);
        if (linked >= 0) {
          this.index = linked;
        } else {
          console.warn(`Game ${this.options.initialGameId} not found, showing first game`);
          this.index = 0;
        }
      } else {
        this.index = 0;
      }
      this.empty = this.games.length === 0;
      return this.games.length > 0;
    } catch (error) {
      console.error('Failed to load games:', error);
      this.empty = true;
      return false;
    } finally {
      this.loading = false;
    }
  }

  loadMore(): Promise<boolean> {
    if (this.moreGamesRequest) return this.moreGamesRequest;
    if (this.destroyed || !this.hasMore) return Promise.resolve(false);
    this.moreGamesRequest = this.fetchMore().finally(() => {
      this.moreGamesRequest = null;
    });
    return this.moreGamesRequest;
  }

  private async fetchMore(): Promise<boolean> {
    this.loadingMore = true;
    const previousCount = this.games.length;
    const previousOffset = this.shuffleToken ? this.shuffleOffset : this.recommendedOffset;
    const signedIn = Boolean(this.options.currentUser);
    const useRecommended = signedIn && !this.shuffleToken;

    try {
      const url = buildMoreGamesUrl({
        signedIn,
        clientRank: Boolean(this.recommendedProfile),
        shuffleToken: this.shuffleToken,
        shuffleOffset: this.shuffleOffset,
        recommendedOffset: this.recommendedOffset,
        limit: 120,
      });
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) return false;
      const data = (await response.json()) as GamesResponse;
      if (this.destroyed) return false;

      const incoming =
        useRecommended && this.recommendedProfile
          ? rankGames(data, { profile: this.recommendedProfile.vector, promoteInitial: false })
          : (data.games ?? []);
      const merged = mergeGamePage(this.games, incoming, this.missingGameIds);
      this.games = merged.games;

      this.shuffleToken = data.token ?? null;
      this.hasMore = Boolean(data.hasMore);
      if (data.token) {
        this.shuffleOffset = data.offset ?? 0;
      } else {
        this.recommendedOffset = data.offset ?? 0;
      }
      const nextOffset = data.token ? this.shuffleOffset : this.recommendedOffset;
      return this.games.length > previousCount || nextOffset > previousOffset;
    } catch (error) {
      console.error('Failed to load more games:', error);
      return false;
    } finally {
      this.loadingMore = false;
    }
  }

  /**
   * Find the nearest playable game from `startIndex`, advancing pages and
   * dropping every entry whose payload is gone.
   */
  async select(startIndex: number, signal: AbortSignal): Promise<ArcadeFeedSelection | null> {
    const selection = await findAvailableArcadeGame(this.games, startIndex, {
      isAvailable: (game) => this.availability.isAvailable(game, signal),
      loadMore: () => this.loadMore(),
      onMissing: (game) => this.missingGameIds.add(game.postId),
      signal,
    });
    if (this.destroyed) return null;
    if (selection) this.index = selection.index;
    return selection;
  }

  prefetchAhead(count = 2): void {
    for (let offset = 1; offset <= count; offset += 1) {
      const game = this.games[this.index + offset];
      if (game) void this.availability.prefetch(game).catch(() => {});
    }
  }

  /** Keep the active card in sync after a fresh/bookmark mutation. */
  replaceGame(game: Game): void {
    this.games = this.games.map((entry) => (entry.postId === game.postId ? game : entry));
  }

  destroy(): void {
    this.destroyed = true;
    this.availability.destroy();
  }
}
