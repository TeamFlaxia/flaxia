import { installAssetRuntime, prepareGame } from '../../sandbox/game-loader/runtime.js';

// Bundled first-party bootstrap. Uploaded bytes are received only after this
// document has an opaque origin, with no app DOM/storage or native privileges.
window.addEventListener('message', function initialize(event) {
  if (event.source !== window.parent || event.data?.type !== 'FLAXIA_LOCAL_GAME' || !event.ports[0]) return;
  window.removeEventListener('message', initialize);
  const port = event.ports[0];
  try {
    const game = prepareGame(event.data.files);
    const values = new Map(Object.entries(event.data.snapshot ?? {}));
    const storage = {
      get length() {
        return values.size;
      },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(String(key)) ?? null,
      setItem(key, value) {
        const next = new Map(values);
        next.set(String(key), String(value));
        if (JSON.stringify(Object.fromEntries(next)).length > 65536)
          throw new DOMException('Game save is full', 'QuotaExceededError');
        values.set(String(key), String(value));
        port.postMessage({ save: Object.fromEntries(values) });
      },
      removeItem(key) {
        values.delete(String(key));
        port.postMessage({ save: Object.fromEntries(values) });
      },
      clear() {
        values.clear();
        port.postMessage({ save: {} });
      },
    };
    Object.defineProperty(window, 'localStorage', {
      value: new Proxy(storage, {
        get: (target, key) => (key in target ? Reflect.get(target, key) : storage.getItem(key)),
        set: (_target, key, value) => {
          storage.setItem(key, value);
          return true;
        },
        deleteProperty: (_target, key) => {
          storage.removeItem(key);
          return true;
        },
      }),
    });
    installAssetRuntime(game.assetUrl);
    window.addEventListener('pagehide', game.dispose, { once: true });
    document.open();
    document.write(game.html);
    document.close();
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Game preparation failed' });
  }
});
window.parent.postMessage({ type: 'FLAXIA_LOCAL_GAME_READY' }, '*');
