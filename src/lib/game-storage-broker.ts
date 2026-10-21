import {
  clearGameStorage,
  hasGameStorageState,
  loadGameStorageSnapshot,
  removeGameStorageValue,
  replaceGameStorageSnapshot,
  setGameStorageValue,
} from '../../sandbox/game-storage-runtime.js';

const STORAGE_FRAME_ID = 'flaxia-game-storage-broker';
const STORAGE_FRAME_PATH = '/api/game-storage';

interface StorageMessage extends Record<string, unknown> {
  type: string;
}

let requestId = 0;
let brokerLoad: Promise<HTMLIFrameElement> | null = null;

function brokerOriginFor(sandboxOrigin: string): string {
  return new URL(sandboxOrigin).origin;
}

function ensureStorageBroker(sandboxOrigin: string): Promise<HTMLIFrameElement> {
  if (brokerLoad) return brokerLoad;

  const pending: Promise<HTMLIFrameElement> = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const existing = document.getElementById(STORAGE_FRAME_ID);
    const iframe = existing instanceof HTMLIFrameElement ? existing : document.createElement('iframe');
    const timeout = window.setTimeout(() => reject(new Error('Game storage broker timed out')), 15000);

    const onLoad = () => {
      window.clearTimeout(timeout);
      iframe.removeEventListener('load', onLoad);
      resolve(iframe);
    };
    iframe.addEventListener('load', onLoad, { once: true });
    iframe.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Game storage broker failed to load'));
    };
    iframe.id = STORAGE_FRAME_ID;
    iframe.title = 'Game storage compatibility';
    iframe.tabIndex = -1;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText =
      'position:fixed;width:1px;height:1px;left:-10px;bottom:0;border:0;opacity:0;pointer-events:none';
    if (!existing) {
      iframe.src = `${brokerOriginFor(sandboxOrigin)}${STORAGE_FRAME_PATH}`;
      document.body.appendChild(iframe);
    } else if (iframe.contentWindow) {
      window.clearTimeout(timeout);
      resolve(iframe);
    }
  }).catch((error: unknown) => {
    brokerLoad = null;
    throw error;
  });
  brokerLoad = pending;

  return pending;
}

// Storage namespace: one game's keys must never be visible to another (#118).
// The sandbox broker reads current blobs and #118's per-key prefix in place,
// with a legacy <postId> blob fallback; unattributed origin-wide keys are ignored.
function namespaceFor(postId: string): string | null {
  if (typeof postId !== 'string' || postId.length === 0 || postId.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(postId)) return null;
  return postId;
}

export async function loadLegacyGameStorage(sandboxOrigin: string, postId: string): Promise<Record<string, string>> {
  const namespace = namespaceFor(postId);
  if (!namespace) throw new Error('Invalid game storage namespace');
  const validNamespace = namespace;
  if (hasGameStorageState(window.localStorage, validNamespace)) {
    return loadGameStorageSnapshot(window.localStorage, validNamespace);
  }

  const iframe = await ensureStorageBroker(sandboxOrigin);
  const origin = brokerOriginFor(sandboxOrigin);
  const id = `snapshot-${++requestId}`;

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Game storage snapshot timed out'));
    }, 10000);

    function onMessage(event: MessageEvent<StorageMessage>): void {
      if (event.source !== iframe.contentWindow || event.origin !== origin) return;
      if (event.data?.type === 'FLAXIA_STORAGE_ERROR') {
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        reject(new Error(typeof event.data.message === 'string' ? event.data.message : 'Game storage read failed'));
        return;
      }
      if (event.data?.type !== 'FLAXIA_STORAGE_SNAPSHOT' || event.data.requestId !== id) return;
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      const entries = event.data.entries;
      if (!Array.isArray(entries)) {
        reject(new Error('Invalid game storage snapshot'));
        return;
      }
      const snapshot: Record<string, string> = Object.create(null);
      for (const entry of entries) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string'
        ) {
          snapshot[entry[0]] = entry[1];
        }
      }
      try {
        replaceGameStorageSnapshot(window.localStorage, validNamespace, snapshot);
      } catch (error) {
        reject(error);
        return;
      }
      resolve(snapshot);
    }

    window.addEventListener('message', onMessage);
    iframe.contentWindow?.postMessage(
      { type: 'FLAXIA_STORAGE_READ', requestId: id, namespace: validNamespace },
      origin,
    );
  });
}

export function connectGameStorage(iframe: HTMLIFrameElement, postId: string): () => void {
  const namespace = namespaceFor(postId);
  if (!namespace) return () => {};
  const onMessage = (event: MessageEvent<StorageMessage>) => {
    if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
    const data = event.data;
    if (data?.type !== 'FLAXIA_GAME_STORAGE_WRITE') return;

    try {
      const operation = data.operation;
      if (operation === 'clear') {
        clearGameStorage(window.localStorage, namespace);
      } else if (operation === 'set' && typeof data.key === 'string' && typeof data.value === 'string') {
        setGameStorageValue(window.localStorage, namespace, data.key, data.value);
      } else if (operation === 'remove' && typeof data.key === 'string') {
        removeGameStorageValue(window.localStorage, namespace, data.key);
      }
    } catch (error) {
      console.error('Could not persist game storage in Flaxia:', error);
    }
  };

  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
