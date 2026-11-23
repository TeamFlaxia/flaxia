// Unit tests for the non-DOM Arcade page helpers. The Svelte surface owns the
// DOM; these modules own feed URL construction, ranking, paging merges, swipe
// classification and interaction-event shaping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Game } from '../src/types/game.js';

const {
  buildInitialGamesUrl,
  buildMoreGamesUrl,
  createArcadeEvent,
  mergeGamePage,
  rankGames,
  resolveSwipe,
  shouldRefreshProfile,
  viewSkipFlag,
} = await import('../src/lib/arcade/feed-core.ts');

const { encodeVector } = await import('../shared/recommendation/vector-codec.ts');

function game(id: string, overrides: Partial<Game> = {}): Game {
  return {
    id,
    postId: id,
    title: `Game ${id}`,
    username: 'author',
    type: 'zip',
    freshCount: 0,
    replyCount: 0,
    bookmarkCount: 0,
    impressions: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('initial game URLs preserve guest shuffle, deep links and client ranking', () => {
  assert.equal(buildInitialGamesUrl({ signedIn: false }), '/api/games?shuffle=true');
  assert.equal(
    buildInitialGamesUrl({ signedIn: true, initialGameId: 'post/1' }),
    '/api/games?recommended=true&initialId=post%2F1',
  );
  assert.equal(
    buildInitialGamesUrl({ signedIn: true, clientRank: true, initialGameId: 'g1', limit: 200 }),
    '/api/games?recommended=true&client_rank=1&include_vectors=1&limit=200&initialId=g1',
  );
});

test('paging game URLs switch between token and offset transports', () => {
  assert.equal(
    buildMoreGamesUrl({ signedIn: true, clientRank: true, recommendedOffset: 40, limit: 120 }),
    '/api/games?recommended=true&offset=40&client_rank=1&include_vectors=1&limit=120',
  );
  assert.equal(
    buildMoreGamesUrl({ signedIn: false, shuffleToken: 'tok', shuffleOffset: 20 }),
    '/api/games?shuffle=true&token=tok&offset=20',
  );
  assert.equal(buildMoreGamesUrl({ signedIn: false }), '/api/games?shuffle=true');
});

test('mergeGamePage appends new games once and skips removed entries', () => {
  const a = game('a');
  const b = game('b');
  const c = game('c');
  const merged = mergeGamePage([a], [a, b, c], new Set(['b']));

  assert.deepEqual(
    merged.games.map((entry) => entry.id),
    ['a', 'c'],
  );
  assert.equal(merged.added, 1);
  assert.equal(mergeGamePage([], [], new Set()).added, 0);
});

test('rankGames preserves server order without a profile', () => {
  const first = game('first');
  const second = game('second');
  const ranked = rankGames({ games: [first, second] }, { profile: null });
  assert.deepEqual(
    ranked.map((entry) => entry.id),
    ['first', 'second'],
  );
});

test('rankGames blends the vault vector and can promote a deep-linked game', () => {
  const aligned = game('aligned', { username: 'a' });
  const orthogonal = game('orthogonal', { username: 'b' });
  const response = {
    games: [orthogonal, aligned],
    vectors: {
      aligned: encodeVector([1, 0])!,
      orthogonal: encodeVector([0, 1])!,
    },
    base_scores: { aligned: 0.5, orthogonal: 0.5 },
    vector_meta: { dim: 2 },
  };

  const ranked = rankGames(response, { profile: [1, 0] });
  assert.equal(ranked[0]?.id, 'aligned', 'the matching embedding should rank first');

  const promoted = rankGames(response, { profile: [1, 0], initialGameId: 'orthogonal' });
  assert.equal(promoted[0]?.id, 'orthogonal', 'a deep link is promoted ahead of the ranking');
});

test('resolveSwipe prioritises vertical distance and momentum', () => {
  assert.equal(resolveSwipe({ startX: 0, startY: 200, endX: 4, endY: 100, velocity: 0 }), 'next');
  assert.equal(resolveSwipe({ startX: 0, startY: 100, endX: 2, endY: 200, velocity: 0 }), 'previous');
  assert.equal(resolveSwipe({ startX: 0, startY: 100, endX: 1, endY: 98, velocity: -0.5 }), 'next');
  assert.equal(resolveSwipe({ startX: 0, startY: 100, endX: 1, endY: 102, velocity: 0.5 }), 'previous');
  assert.equal(resolveSwipe({ startX: 0, startY: 100, endX: 200, endY: 96, velocity: 0 }), 'reset');
  assert.equal(resolveSwipe({ startX: 0, startY: 100, endX: 2, endY: 98, velocity: 0 }), 'reset');
});

test('arcade events capture position, velocity and dwell-driven flags', () => {
  const event = createArcadeEvent({
    postId: 'g1',
    eventType: 'view',
    dwellMs: 900,
    isFullscreen: 0,
    gameType: 'zip',
    position: 3,
    swipeVelocity: -0.4,
  });

  assert.equal(event.position, 3);
  assert.equal(event.swipeVelocity, 0.4);
  assert.equal(event.didSkip, 1);
  assert.equal(viewSkipFlag(2000), 0);
  assert.equal(viewSkipFlag(1999), 1);
});

test('long dwells refresh the recommendation profile only when requested', () => {
  assert.equal(shouldRefreshProfile([{ dwellMs: 5000 }, { dwellMs: 4000 }]), false);
  assert.equal(shouldRefreshProfile([{ dwellMs: 1200 }, { dwellMs: 5001 }]), true);
  assert.equal(shouldRefreshProfile([]), false);
});
