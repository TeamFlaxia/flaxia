import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMigratedGameStorage, type GameStorageLike } from '../src/lib/game-storage-migration.ts';

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
}

test('new per-game blob is authoritative', () => {
  const postId = 'game-new';
  const storage = new MemoryStorage({
    cuteTankSave_v2: 'shared-old',
    [postId]: JSON.stringify({ cuteTankSave_v2: 'post-old' }),
    ['flaxia:game:' + postId + ':cuteTankSave_v2']: 'prefixed-old',
    ['flaxia:game:' + postId]: JSON.stringify({ cuteTankSave_v2: 'new-save' }),
  });

  assert.deepEqual(loadMigratedGameStorage(storage, postId), {
    cuteTankSave_v2: 'new-save',
  });
});

test('current prefixed layout migrates into the new blob', () => {
  const postId = 'game-prefixed';
  const storage = new MemoryStorage({
    ['flaxia:game:' + postId + ':cuteTankSave_v2']: '{"fish":"ぷりん"}',
    ['flaxia:game:' + postId + ':volume']: '0.5',
  });

  const snapshot = loadMigratedGameStorage(storage, postId);

  assert.deepEqual(snapshot, {
    cuteTankSave_v2: '{"fish":"ぷりん"}',
    volume: '0.5',
  });
  assert.deepEqual(JSON.parse(storage.getItem('flaxia:game:' + postId) ?? 'null'), snapshot);
});

test('legacy postId JSON blob migrates when newer formats are absent', () => {
  const postId = 'game-post-id';
  const legacy = {
    cuteTankSave_v2: '{"level":7}',
    volume: '0.5',
  };
  const storage = new MemoryStorage({
    [postId]: JSON.stringify(legacy),
  });

  assert.deepEqual(loadMigratedGameStorage(storage, postId), legacy);
  assert.deepEqual(JSON.parse(storage.getItem('flaxia:game:' + postId) ?? 'null'), legacy);
});

test('old shared storage is exposed to an unmigrated game and copied into its new blob', () => {
  const postId = '769f7687-93e3-4990-894c-13e9268ab950';
  const storage = new MemoryStorage({
    cuteTankSave_v2: '{"v":3,"fish":"ぷりん"}',
    anotherLegacyGameSave: '{"score":9001}',
  });

  const snapshot = loadMigratedGameStorage(storage, postId);

  assert.deepEqual(snapshot, {
    cuteTankSave_v2: '{"v":3,"fish":"ぷりん"}',
    anotherLegacyGameSave: '{"score":9001}',
  });
  assert.deepEqual(JSON.parse(storage.getItem('flaxia:game:' + postId) ?? 'null'), snapshot);

  // Migration copies legacy data; it does not delete or rewrite the original shared keys.
  assert.equal(storage.getItem('cuteTankSave_v2'), '{"v":3,"fish":"ぷりん"}');
  assert.equal(storage.getItem('anotherLegacyGameSave'), '{"score":9001}');
});

test('an intentionally empty new blob prevents legacy data from being resurrected', () => {
  const postId = 'game-cleared';
  const storage = new MemoryStorage({
    cuteTankSave_v2: 'old-save',
    ['flaxia:game:' + postId]: '{}',
  });

  assert.deepEqual(loadMigratedGameStorage(storage, postId), {});
});
