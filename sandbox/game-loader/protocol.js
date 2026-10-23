export const CACHE_PREFIX = 'flaxia-loader-prototype-v1-';
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_FILES = 1024;
export const HASH_PATTERN = /^[a-f0-9]{64}$/;
export const MIME_TYPES = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  txt: 'text/plain',
  wasm: 'application/wasm',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  data: 'application/octet-stream',
  bin: 'application/octet-stream',
};

export function validatePath(path) {
  if (typeof path !== 'string' || !path || path.length > 255 || path.split('/').length > 11) return false;
  return (
    !path.startsWith('/') &&
    !/[\\:?#%]/.test(path) &&
    ![...path].some((character) => character.charCodeAt(0) < 32) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

export function mimeType(path) {
  return MIME_TYPES[path.split('.').pop()?.toLowerCase()] ?? null;
}

export function validateFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error('Invalid file count');
  const seen = new Set();
  let total = 0;
  for (const file of files) {
    if (
      !file ||
      !validatePath(file.path) ||
      !mimeType(file.path) ||
      seen.has(file.path) ||
      !(file.bytes instanceof ArrayBuffer)
    )
      throw new Error('Invalid archive entry');
    seen.add(file.path);
    total += file.bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new Error('Expanded archive exceeds 100 MB');
  }
  const indexes = [...seen].filter((path) => /(^|\/)index\.html?$/i.test(path));
  indexes.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (!indexes.length) throw new Error('No index.html found');
  return indexes[0];
}

export function resolvePath(raw, base) {
  if (typeof raw !== 'string' || !raw || raw.startsWith('#') || raw.startsWith('?')) return null;
  const url = new URL(raw, new URL(base, 'https://archive.invalid/'));
  if (url.origin !== 'https://archive.invalid') return null;
  return { path: decodeURIComponent(url.pathname.slice(1)), suffix: url.hash };
}
