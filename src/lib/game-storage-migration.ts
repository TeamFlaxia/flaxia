export interface GameStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadMigratedGameStorage(storage: GameStorageLike, namespace: string): Record<string, string> {
  function decodeSnapshot(raw: string | null): Record<string, string> | null {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const snapshot: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') snapshot[key] = value;
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  const storageKey = `flaxia:game:${namespace}`;
  const currentRaw = storage.getItem(storageKey);

  // Presence of the new blob is authoritative, including an intentionally empty {}.
  if (currentRaw !== null) return decodeSnapshot(currentRaw) ?? {};

  // Compatibility with the #118 per-key layout.
  const prefix = `${storageKey}:`;
  const prefixed: Record<string, string> = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key === null || !key.startsWith(prefix)) continue;
    const value = storage.getItem(key);
    if (value !== null) prefixed[key.slice(prefix.length)] = value;
  }
  if (Object.keys(prefixed).length > 0) {
    storage.setItem(storageKey, JSON.stringify(prefixed));
    return prefixed;
  }

  // Older one-blob layout stored the snapshot directly under <postId>.
  const legacy = decodeSnapshot(storage.getItem(namespace));
  if (legacy !== null) {
    storage.setItem(storageKey, JSON.stringify(legacy));
    return legacy;
  }

  // Temporary rescue window: before #118 every game shared the sandbox origin's
  // plain localStorage. Expose those non-Flaxia-prefixed keys to each unmigrated
  // game once, then persist the snapshot into its new per-game blob.
  const shared: Record<string, string> = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key === null || key.startsWith('flaxia:game:')) continue;
    const value = storage.getItem(key);
    if (value !== null) shared[key] = value;
  }
  if (Object.keys(shared).length > 0) {
    storage.setItem(storageKey, JSON.stringify(shared));
  }
  return shared;
}
