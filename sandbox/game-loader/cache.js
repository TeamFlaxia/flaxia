import { CACHE_PREFIX, HASH_PATTERN, mimeType, validateFiles, validatePath } from './protocol.js';

const marker = (origin) => new URL('/game-loader/cache/complete', origin).href;
const fileKey = (origin, path) =>
  new URL(`/game-loader/cache/files/${path.split('/').map(encodeURIComponent).join('/')}`, origin).href;

// These URLs are CacheStorage keys only. No fetch handler serves uploaded bytes.
export async function readArchive(storage, origin, hash) {
  if (!HASH_PATTERN.test(hash)) throw new Error('Invalid archive hash');
  const name = CACHE_PREFIX + hash;
  if (!(await storage.has(name))) return null;
  const cache = await storage.open(name);
  const completed = await cache.match(marker(origin));
  if (!completed) return null;
  try {
    const manifest = await completed.json();
    if (!Array.isArray(manifest.paths) || manifest.paths.length > 1024) throw new Error('Invalid manifest');
    const files = [];
    for (const path of manifest.paths) {
      if (!validatePath(path)) throw new Error('Invalid cached path');
      const response = await cache.match(fileKey(origin, path));
      if (!response) throw new Error('Incomplete archive');
      files.push({ path, bytes: await response.arrayBuffer() });
    }
    return { files, entry: validateFiles(files) };
  } catch {
    await storage.delete(name);
    return null;
  }
}

export async function writeArchive(storage, origin, hash, files) {
  if (!HASH_PATTERN.test(hash)) throw new Error('Invalid archive hash');
  const entry = validateFiles(files);
  const name = CACHE_PREFIX + hash;
  // Drop the completion marker first. Interrupted writes can never appear ready.
  await storage.delete(name);
  try {
    const cache = await storage.open(name);
    for (const file of files) {
      await cache.put(
        fileKey(origin, file.path),
        new Response(file.bytes, {
          headers: { 'Content-Type': mimeType(file.path) },
        }),
      );
    }
    await cache.put(marker(origin), Response.json({ paths: files.map((file) => file.path) }));
    return entry;
  } catch (error) {
    await storage.delete(name).catch(() => {});
    throw error;
  }
}
