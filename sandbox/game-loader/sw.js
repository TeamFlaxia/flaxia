import { readArchive, writeArchive } from './cache.js';
import { CACHE_PREFIX } from './protocol.js';

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Serialize reads/writes so two loader tabs cannot observe a partial overwrite.
let queue = Promise.resolve();
self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (!port || !event.source?.id) return;
  const pending = queue.then(async () => {
    const client = await self.clients.get(event.source.id);
    if (!client) return;
    const url = new URL(client.url);
    if (
      url.origin !== self.location.origin ||
      !['/game-loader/prototype', '/game-loader/prototype.html'].includes(url.pathname)
    )
      return;
    const { type, hash, files } = event.data ?? {};
    try {
      if (type === 'READ_ARCHIVE') {
        const result = await readArchive(caches, self.location.origin, hash);
        port.postMessage({ ok: true, result }, result?.files.map((file) => file.bytes) ?? []);
      } else if (type === 'WRITE_ARCHIVE') {
        const entry = await writeArchive(caches, self.location.origin, hash, files);
        port.postMessage({ ok: true, result: { entry } });
      } else if (type === 'CLEAR_ARCHIVES') {
        for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX)) await caches.delete(name);
        port.postMessage({ ok: true });
      } else throw new Error('Unknown loader request');
    } catch (error) {
      port.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Cache operation failed' });
    } finally {
      port.close();
    }
  });
  queue = pending.catch(() => {});
  event.waitUntil(queue);
});
