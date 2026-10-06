/**
 * @typedef {object} GameStorageLike
 * @property {number} length
 * @property {(index: number) => string | null} key
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

/** @param {string | null} raw */
function decodeSnapshot(raw) {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const snapshot = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        Object.defineProperty(snapshot, key, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
      }
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** @param {Record<string, string>} snapshot @param {string} key @param {string} value */
function setSnapshotValue(snapshot, key, value) {
  Object.defineProperty(snapshot, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** @param {GameStorageLike} storage @param {string} prefix */
function readPrefixedSnapshot(storage, prefix) {
  const snapshot = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key === null || !key.startsWith(prefix)) continue;
    const value = storage.getItem(key);
    if (value !== null) setSnapshotValue(snapshot, key.slice(prefix.length), value);
  }
  return snapshot;
}

/** @param {GameStorageLike} storage @param {string} prefix */
function hasPrefixedKeys(storage, prefix) {
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Select an existing storage format without copying it. Keeping legacy formats
 * in place avoids duplicating large saves and exhausting the origin's quota.
 * @param {GameStorageLike} storage
 * @param {string} namespace
 */
function findStorageState(storage, namespace) {
  const currentBlobKey = 'flaxia:game:' + namespace;
  const currentRaw = storage.getItem(currentBlobKey);
  if (currentRaw !== null) {
    return {
      kind: 'blob',
      key: currentBlobKey,
      snapshot: decodeSnapshot(currentRaw) ?? {},
    };
  }

  const prefix = currentBlobKey + ':';
  const prefixed = readPrefixedSnapshot(storage, prefix);
  if (Object.keys(prefixed).length > 0) {
    return { kind: 'prefixed', prefix, snapshot: prefixed };
  }

  const legacy = decodeSnapshot(storage.getItem(namespace));
  if (legacy !== null) return { kind: 'blob', key: namespace, snapshot: legacy };

  return { kind: 'prefixed', prefix, snapshot: {} };
}

/**
 * Read the post's snapshot. Unattributed pre-#118 origin-wide keys are
 * intentionally ignored: they cannot be safely assigned to one game.
 * @param {GameStorageLike} storage
 * @param {string} namespace
 * @returns {Record<string, string>}
 */
export function loadGameStorageSnapshot(storage, namespace) {
  return findStorageState(storage, namespace).snapshot;
}

/** @param {GameStorageLike} storage @param {string} namespace @param {string} key @param {string} value */
export function setGameStorageValue(storage, namespace, key, value) {
  const state = findStorageState(storage, namespace);
  if (state.kind === 'blob') {
    setSnapshotValue(state.snapshot, key, value);
    storage.setItem(state.key, JSON.stringify(state.snapshot));
    return;
  }
  storage.setItem(state.prefix + key, value);
}

/** @param {GameStorageLike} storage @param {string} namespace @param {string} key */
export function removeGameStorageValue(storage, namespace, key) {
  const state = findStorageState(storage, namespace);
  if (state.kind === 'blob') {
    delete state.snapshot[key];
    storage.setItem(state.key, JSON.stringify(state.snapshot));
    return;
  }

  storage.removeItem(state.prefix + key);
  if (!hasPrefixedKeys(storage, state.prefix)) {
    // A higher-priority empty blob prevents a lower-priority legacy blob from
    // resurfacing after the last prefixed key is removed.
    storage.setItem('flaxia:game:' + namespace, '{}');
  }
}

/** @param {GameStorageLike} storage @param {string} namespace */
export function clearGameStorage(storage, namespace) {
  const state = findStorageState(storage, namespace);
  if (state.kind === 'blob') {
    storage.setItem(state.key, '{}');
    return;
  }

  const keys = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(state.prefix)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
  if (keys.length > 0) storage.setItem('flaxia:game:' + namespace, '{}');
}
