import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWvfsGameUrl } from '../src/lib/wvfs-game-url.ts';

test('game documents use a fresh URL instead of the old immutable cache key', () => {
  const url = new URL(createWvfsGameUrl('https://sandbox.example', 'game-id'));
  assert.equal(url.origin, 'https://sandbox.example');
  assert.equal(url.pathname, '/api/wvfs-zip/game-id');
  assert.equal(url.searchParams.get('runtime'), '2');
  assert.equal(url.searchParams.has('v'), false);
});

test('versioned prewarm and iframe URLs keep the same game version in query parameters', () => {
  const options = { versionId: 'version-id' };
  const game = new URL(createWvfsGameUrl('https://sandbox.example/', 'game-id', options));
  const prewarm = new URL(createWvfsGameUrl('https://sandbox.example/', 'game-id', { ...options, index: true }));
  assert.equal(prewarm.pathname, `${game.pathname}/index.html`);
  assert.equal(prewarm.search, game.search);
  assert.equal(prewarm.searchParams.get('v'), 'version-id');
});

test('identifiers cannot inject URL paths, query parameters, or fragments', () => {
  const url = new URL(
    createWvfsGameUrl('https://sandbox.example', 'game/other?runtime=1#fragment', { versionId: 'v&x=1' }),
  );
  assert.equal(url.pathname, '/api/wvfs-zip/game%2Fother%3Fruntime%3D1%23fragment');
  assert.equal(url.searchParams.get('runtime'), '2');
  assert.equal(url.searchParams.get('v'), 'v&x=1');
  assert.equal(url.searchParams.has('x'), false);
  assert.equal(url.hash, '');
});
