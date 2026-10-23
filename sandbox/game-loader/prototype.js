import { HASH_PATTERN, MAX_ZIP_BYTES, validateFiles } from './protocol.js';

const status = document.getElementById('status');
const metrics = document.getElementById('metrics');
const input = document.getElementById('archive');
const reopen = document.getElementById('reopen');
const clear = document.getElementById('clear');
const container = document.getElementById('game');
const LAST_HASH = 'flaxia-loader-prototype-last';
let lastHash;
try {
  lastHash = localStorage.getItem(LAST_HASH);
} catch {
  /* storage may be disabled */
}
let busy = false;
const swReady = Promise.resolve().then(async () => {
  if (!('serviceWorker' in navigator)) throw new Error('Service Worker unavailable');
  await navigator.serviceWorker.register('/game-loader/sw.js', { type: 'module', scope: '/game-loader/' });
  let timeout;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Service Worker activation timed out')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
});

function rpc(target, message, transfer = []) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Loader request timed out'));
    }, 15000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      if (event.data?.ok) resolve(event.data.result);
      else reject(new Error(event.data?.error ?? 'Loader operation failed'));
    };
    target.postMessage(message, [channel.port2, ...transfer]);
  });
}
async function cacheRequest(message, transfer) {
  const registration = await swReady;
  if (!registration.active) throw new Error('Service Worker is not active');
  return rpc(registration.active, message, transfer);
}
function unzip(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/game-loader/generated/unzip-worker.js', { type: 'module' });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('ZIP extraction timed out'));
    }, 15000);
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event) => {
      finish();
      if (event.data?.ok) resolve(event.data.files);
      else reject(new Error(event.data?.error ?? 'ZIP extraction failed'));
    };
    worker.onerror = () => {
      finish();
      reject(new Error('ZIP worker failed'));
    };
    worker.postMessage(bytes, [bytes]);
  });
}
async function play(files) {
  validateFiles(files);
  container.replaceChildren();
  const iframe = document.createElement('iframe');
  iframe.title = 'Isolated local game';
  iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
  iframe.referrerPolicy = 'no-referrer';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', ready);
      reject(new Error('Game shell timed out'));
    }, 10000);
    function ready(event) {
      if (
        event.source !== iframe.contentWindow ||
        event.origin !== 'null' ||
        event.data?.type !== 'LOCAL_GAME_SHELL_READY'
      )
        return;
      clearTimeout(timeout);
      window.removeEventListener('message', ready);
      const channel = new MessageChannel();
      const gameTimeout = setTimeout(() => {
        channel.port1.close();
        reject(new Error('Game initialization timed out'));
      }, 10000);
      channel.port1.onmessage = (reply) => {
        clearTimeout(gameTimeout);
        channel.port1.close();
        if (reply.data?.ok) resolve();
        else reject(new Error(reply.data?.error ?? 'Game initialization failed'));
      };
      iframe.contentWindow.postMessage({ type: 'START_LOCAL_GAME', files }, '*', [
        channel.port2,
        ...files.map((file) => file.bytes),
      ]);
    }
    window.addEventListener('message', ready);
    iframe.src = '/game-loader/game-shell.html';
    container.appendChild(iframe);
  });
}
async function run(file) {
  if (busy) return;
  busy = true;
  status.dataset.state = 'loading';
  metrics.textContent = '';
  input.disabled = reopen.disabled = clear.disabled = true;
  const started = performance.now();
  let cache = 'MISS';
  let extractionMs = 0;
  try {
    status.textContent = 'Reading local archive…';
    let bytes;
    let hash = lastHash;
    if (file) {
      if (file.size > MAX_ZIP_BYTES) throw new Error('ZIP exceeds 25 MB');
      bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    if (!HASH_PATTERN.test(hash)) throw new Error('No saved archive');
    let result = await cacheRequest({ type: 'READ_ARCHIVE', hash });
    if (result) cache = 'HIT';
    else {
      if (!bytes) throw new Error('Saved archive was evicted. Choose the ZIP again.');
      status.textContent = 'Extracting in background worker…';
      const extractionStarted = performance.now();
      const files = await unzip(bytes);
      extractionMs = performance.now() - extractionStarted;
      status.textContent = 'Saving extracted assets…';
      await cacheRequest(
        { type: 'WRITE_ARCHIVE', hash, files },
        files.map((file) => file.bytes),
      );
      result = await cacheRequest({ type: 'READ_ARCHIVE', hash });
      if (!result) throw new Error('Cache write was incomplete');
    }
    await play(result.files);
    lastHash = hash;
    try {
      localStorage.setItem(LAST_HASH, hash);
    } catch {
      /* current-session reopen still works */
    }
    metrics.textContent = JSON.stringify({
      cache,
      extractionMs: Math.round(extractionMs),
      shellReadyMs: Math.round(performance.now() - started),
    });
    status.textContent = 'Game shell ready. This does not measure the game’s first playable frame.';
    status.dataset.state = 'ready';
  } catch (error) {
    container.replaceChildren();
    status.textContent = error instanceof Error ? error.message : 'Game load failed';
    status.dataset.state = 'error';
  } finally {
    busy = false;
    input.disabled = clear.disabled = false;
    reopen.disabled = !HASH_PATTERN.test(lastHash);
  }
}
input.addEventListener('change', () => {
  if (input.files[0]) void run(input.files[0]);
});
reopen.addEventListener('click', () => void run());
clear.addEventListener('click', async () => {
  if (busy) return;
  try {
    await cacheRequest({ type: 'CLEAR_ARCHIVES' });
    lastHash = null;
    try {
      localStorage.removeItem(LAST_HASH);
    } catch {
      /* non-critical */
    }
    reopen.disabled = true;
    status.textContent = 'Prototype cache cleared.';
  } catch (error) {
    status.textContent = String(error);
  }
});
swReady
  .then(() => {
    status.textContent = 'Choose a ZIP or reopen the saved game.';
    reopen.disabled = !HASH_PATTERN.test(lastHash);
  })
  .catch(() => {
    input.disabled = reopen.disabled = clear.disabled = true;
    status.textContent = 'Service Worker unavailable. Normal public games continue to use WVFS.';
  });
