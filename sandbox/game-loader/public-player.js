import { launchWithFallback } from './launch.js';
import { HASH_PATTERN, MAX_ZIP_BYTES } from './protocol.js';

export async function startPublicPlayer({ cacheRequest, unzip, play, container, status, metrics }) {
  const postId = new URL(location.href).searchParams.get('post');
  const version = new URL(location.href).searchParams.get('v');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(postId ?? '')) throw new Error('A public post ID is required');
  const controller = new AbortController();
  window.addEventListener('pagehide', () => controller.abort(), { once: true });
  const descriptorUrl = new URL(`/api/game-loader/${postId}`, location.origin);
  if (version) descriptorUrl.searchParams.set('v', version);
  status.textContent = 'Checking current publication and version…';
  const lookupTimeout = setTimeout(() => controller.abort(), 10000);
  let descriptor;
  try {
    const response = await fetch(descriptorUrl, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error('Game is unavailable. Cached copies will not be played.');
    descriptor = await response.json();
  } finally {
    clearTimeout(lookupTimeout);
  }
  if (!HASH_PATTERN.test(descriptor.revision)) throw new Error('Invalid game revision');
  const wvfsUrl = new URL(descriptor.wvfsUrl);
  const archiveUrl = new URL(descriptor.archiveUrl);
  if (
    wvfsUrl.origin !== location.origin ||
    !wvfsUrl.pathname.startsWith(`/api/wvfs-zip/${postId}`) ||
    archiveUrl.origin !== location.origin ||
    archiveUrl.pathname !== `/api/game-loader/${postId}/archive`
  ) {
    throw new Error('Invalid game source');
  }
  const backgroundStatus = document.createElement('output');
  backgroundStatus.id = 'cache-status';
  metrics.after(backgroundStatus);
  const started = performance.now();
  const result = await launchWithFallback({
    probe: () => (descriptor.cacheable ? cacheRequest({ type: 'READ_ARCHIVE', hash: descriptor.revision }) : null),
    playCached: (cached) => play(cached.files),
    playWvfs: () =>
      new Promise((resolve, reject) => {
        container.replaceChildren();
        const iframe = document.createElement('iframe');
        iframe.title = 'WVFS game';
        iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-forms allow-popups');
        iframe.referrerPolicy = 'no-referrer';
        const timeout = setTimeout(() => reject(new Error('WVFS navigation timed out')), 30000);
        iframe.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        iframe.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('WVFS navigation failed'));
        };
        iframe.src = wvfsUrl.href;
        container.appendChild(iframe);
      }),
    schedule: async (task) => {
      if (!descriptor.cacheable || document.hidden || navigator.connection?.saveData || controller.signal.aborted)
        return;
      // Give the displayed WVFS document a paint opportunity before any ZIP work.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (document.hidden || controller.signal.aborted) return;
      await new Promise((resolve) => {
        const run = () => resolve(task());
        if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 3000 });
        else setTimeout(run, 300);
      });
    },
    warm: async () => {
      if (controller.signal.aborted) return;
      backgroundStatus.dataset.state = 'warming';
      backgroundStatus.textContent = 'WVFS is displayed. Preparing the next launch in the background…';
      try {
        const response = await fetch(archiveUrl, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error(`Archive unavailable (${response.status})`);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error('ZIP exceeds 25 MB');
        const files = await unzip(bytes);
        if (controller.signal.aborted) return;
        await cacheRequest(
          { type: 'WRITE_ARCHIVE', hash: descriptor.revision, files },
          files.map((file) => file.bytes),
        );
        backgroundStatus.dataset.state = 'saved';
        backgroundStatus.textContent = 'Expanded assets saved for the next launch.';
      } catch (error) {
        backgroundStatus.dataset.state = 'error';
        backgroundStatus.textContent = 'Background cache unavailable. WVFS playback continues.';
        throw error;
      }
    },
  });
  status.dataset.state = 'ready';
  status.textContent = result.mode === 'wvfs' ? 'Playing through WVFS.' : 'Playing from the local asset cache.';
  metrics.textContent = JSON.stringify({
    mode: result.mode,
    fallbackReason: result.reason,
    navigationReadyMs: Math.round(performance.now() - started),
  });
}
