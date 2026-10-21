import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  clearGameStorage,
  hasGameStorageState,
  loadGameStorageSnapshot,
  removeGameStorageValue,
  replaceGameStorageSnapshot,
  setGameStorageValue,
} from '../sandbox/game-storage-runtime.js';
import { connectGameStorage, loadLegacyGameStorage } from '../src/lib/game-storage-broker.ts';

interface GameStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MemoryStorage implements GameStorageLike {
  private readonly values = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value);
  }

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const blobKeyFor = (postId: string) => `flaxia:game:${postId}`;
const prefixedKeyFor = (postId: string, key: string) => `${blobKeyFor(postId)}:${key}`;

test('current per-game blob is authoritative and updated in place', () => {
  const postId = 'game-new';
  const storage = new MemoryStorage({
    [prefixedKeyFor(postId, 'score')]: 'stale-prefix',
    [postId]: JSON.stringify({ score: 'stale-legacy' }),
    [blobKeyFor(postId)]: JSON.stringify({ score: 'new-save' }),
    unrelated: 'must-not-be-visible',
  });

  assert.deepEqual(loadGameStorageSnapshot(storage, postId), { score: 'new-save' });
  setGameStorageValue(storage, postId, 'score', 'updated');
  assert.deepEqual(JSON.parse(storage.getItem(blobKeyFor(postId)) ?? 'null'), { score: 'updated' });
});

test('#118 per-key storage is read and written without copying the save', () => {
  const postId = 'game-prefixed';
  const scoreKey = prefixedKeyFor(postId, 'score');
  const volumeKey = prefixedKeyFor(postId, 'volume');
  const storage = new MemoryStorage({ [scoreKey]: '7', [volumeKey]: '0.5' });

  assert.deepEqual(loadGameStorageSnapshot(storage, postId), { score: '7', volume: '0.5' });
  assert.equal(storage.getItem(blobKeyFor(postId)), null);

  setGameStorageValue(storage, postId, 'score', '8');
  assert.equal(storage.getItem(scoreKey), '8');
  assert.equal(storage.getItem(blobKeyFor(postId)), null);
  assert.deepEqual(loadGameStorageSnapshot(storage, postId), { score: '8', volume: '0.5' });
});

test('empty Flaxia-origin save tombstones count as existing state', () => {
  const postId = 'game-empty';
  const storage = new MemoryStorage({ [blobKeyFor(postId)]: '{}' });

  assert.equal(hasGameStorageState(storage, postId), true);
  assert.deepEqual(loadGameStorageSnapshot(storage, postId), {});
});

test('legacy snapshots migrate into Flaxia-origin storage and replace old keys', () => {
  const postId = 'game-migrate';
  const storage = new MemoryStorage({
    [prefixedKeyFor(postId, 'old-score')]: '1',
    [prefixedKeyFor(postId, 'stale')]: 'remove-me',
  });

  replaceGameStorageSnapshot(storage, postId, { score: '2' });

  assert.deepEqual(loadGameStorageSnapshot(storage, postId), { score: '2' });
  assert.equal(storage.getItem(prefixedKeyFor(postId, 'stale')), null);
  replaceGameStorageSnapshot(storage, postId, {});
  assert.equal(hasGameStorageState(storage, postId), true);
  assert.deepEqual(loadGameStorageSnapshot(storage, postId), {});
});

test('game writes are persisted in the Flaxia-origin localStorage', () => {
  const postId = 'game-origin';
  const storage = new MemoryStorage();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const fakeWindow = {
    localStorage: storage,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener),
  } as unknown as Window;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });

  try {
    const gameWindow = {} as WindowProxy;
    const gameIframe = { contentWindow: gameWindow } as HTMLIFrameElement;
    const disconnect = connectGameStorage(gameIframe, postId);
    const listener = Array.from(listeners)[0];
    assert.equal(typeof listener, 'function');
    if (typeof listener !== 'function') throw new Error('Game storage listener was not registered');

    listener({
      source: gameWindow,
      origin: 'null',
      data: { type: 'FLAXIA_GAME_STORAGE_WRITE', operation: 'set', key: 'score', value: '42' },
    } as unknown as MessageEvent);

    assert.deepEqual(loadGameStorageSnapshot(storage, postId), { score: '42' });
    disconnect();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('Flaxia-origin saves are loaded before consulting the legacy sandbox broker', async () => {
  const postId = 'game-local-first';
  const storage = new MemoryStorage({ [blobKeyFor(postId)]: JSON.stringify({ level: '3' }) });
  const fakeWindow = { localStorage: storage } as unknown as Window;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });

  try {
    assert.deepEqual(await loadLegacyGameStorage('https://sandbox.example', postId), { level: '3' });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('legacy postId blob remains in place and can still be updated', () => {
  const postId = 'game-post-id';
  const legacy = { score: '7', volume: '0.5' };
  const storage = new MemoryStorage({ [postId]: JSON.stringify(legacy) });

  assert.deepEqual(loadGameStorageSnapshot(storage, postId), legacy);
  setGameStorageValue(storage, postId, 'volume', '0.75');
  assert.deepEqual(JSON.parse(storage.getItem(postId) ?? 'null'), { score: '7', volume: '0.75' });
  assert.equal(storage.getItem(blobKeyFor(postId)), null);
});

test('unattributed shared storage is never exposed to a game', () => {
  const postId = 'new-game';
  const otherPostId = 'other-game';
  const storage = new MemoryStorage({
    anotherLegacyGameSave: '{"score":9001}',
    cuteTankSave_v2: '{"fish":"ぷりん"}',
    [prefixedKeyFor(otherPostId, 'private-save')]: 'other-game-data',
  });

  assert.deepEqual(loadGameStorageSnapshot(storage, postId), {});
  assert.equal(storage.getItem(blobKeyFor(postId)), null);
  assert.equal(storage.getItem(prefixedKeyFor(otherPostId, 'private-save')), 'other-game-data');

  setGameStorageValue(storage, postId, 'own-save', 'only-this-game');
  assert.equal(storage.getItem(prefixedKeyFor(postId, 'own-save')), 'only-this-game');
  assert.equal(storage.getItem('anotherLegacyGameSave'), '{"score":9001}');
});

test('removing the last prefixed key prevents a lower-priority legacy blob from returning', () => {
  const postId = 'game-cleared';
  const oldPrefixKey = prefixedKeyFor(postId, 'score');
  const storage = new MemoryStorage({
    [oldPrefixKey]: 'newer-prefix-save',
    [postId]: JSON.stringify({ score: 'older-legacy-save' }),
  });

  removeGameStorageValue(storage, postId, 'score');

  assert.equal(storage.getItem(oldPrefixKey), null);
  assert.deepEqual(loadGameStorageSnapshot(storage, postId), {});
  assert.equal(storage.getItem(blobKeyFor(postId)), '{}');
});

test('clearing prefixed storage removes its keys and leaves an empty tombstone', () => {
  const postId = 'game-clear';
  const storage = new MemoryStorage({
    [prefixedKeyFor(postId, 'score')]: '9',
    [prefixedKeyFor(postId, 'volume')]: '0.8',
  });

  clearGameStorage(storage, postId);

  assert.equal(storage.getItem(prefixedKeyFor(postId, 'score')), null);
  assert.equal(storage.getItem(prefixedKeyFor(postId, 'volume')), null);
  assert.deepEqual(loadGameStorageSnapshot(storage, postId), {});
});

test('broker uses the standalone browser runtime instead of stringifying a bundled function', async () => {
  const worker = await readFile(new URL('../src/sandbox-worker.ts', import.meta.url), 'utf8');
  const runtime = await readFile(new URL('../sandbox/game-storage-runtime.js', import.meta.url), 'utf8');

  assert.match(worker, /app\.get\('\/api\/game-storage-runtime\.js'/);
  assert.match(worker, /from '\/api\/game-storage-runtime\.js'/);
  assert.doesNotMatch(worker, /\.toString\(\)/);
  assert.doesNotMatch(runtime, /__name\s*\(/);
});
