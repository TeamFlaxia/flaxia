import { installAssetRuntime, prepareGame } from './runtime.js';

const parentOrigin = new URL(location.href).origin;
window.addEventListener('message', function initialize(event) {
  if (
    event.source !== window.parent ||
    event.origin !== parentOrigin ||
    event.data?.type !== 'START_LOCAL_GAME' ||
    !event.ports[0]
  )
    return;
  window.removeEventListener('message', initialize);
  const port = event.ports[0];
  try {
    const game = prepareGame(event.data.files);
    installAssetRuntime(game.assetUrl);
    window.addEventListener('pagehide', game.dispose, { once: true });
    // The HTTP response's sandbox/CSP remain in force after replacing its DOM.
    document.open();
    document.write(game.html);
    document.close();
    port.postMessage({ ok: true });
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Game preparation failed' });
  } finally {
    port.close();
  }
});
window.parent.postMessage({ type: 'LOCAL_GAME_SHELL_READY' }, parentOrigin);
