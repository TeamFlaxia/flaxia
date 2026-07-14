importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const EXT_CONFIG = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.opus': 'audio/opus',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.unityweb': 'application/octet-stream',
  '.wasm.code': 'application/wasm',
  '.txt': 'text/plain',
  '.glsl': 'text/plain',
  '.wgsl': 'text/plain',
  '.rsp': 'text/plain',
  '.exe': 'application/x-msdos-program',
  '.com': 'application/x-msdos-program',
  '.bat': 'text/plain',
  '.conf': 'text/plain',
  '.cf': 'text/plain',
  '.img': 'application/octet-stream',
  '.iso': 'application/x-iso9660',
  '.dosz': 'application/octet-stream',
  '.zip': 'application/zip',
  '.jsdos': 'application/zip',
  '.ovl': 'application/octet-stream',
  '.db': 'application/x-sqlite3',
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(EXT_CONFIG).map((k) => k.replace('.', '')));

const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const MAX_FILE_COUNT = 1000;
const WVFS_TTL = 5 * 60 * 1000;

const zipStores = new Map();

function cleanupExpired() {
  const now = Date.now();
  for (const [postId, store] of zipStores) {
    if (now - store.createdAt > WVFS_TTL) {
      zipStores.delete(postId);
    }
  }
}

function validatePath(path) {
  if (!path || typeof path !== 'string') return false;
  if (path.length > 255) return false;
  if (path.includes('..') || path.includes('//') || path.includes('\\\\')) return false;
  if (path.includes('\0') || /[<>:"|?*]/.test(path)) return false;

  const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
  const depth = (normalizedPath.match(/\//g) || []).length;
  if (depth > 10) return false;

  const ext = normalizedPath.split('.').pop()?.toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) return false;

  return true;
}

function validateZipContent(files) {
  let totalSize = 0;
  let fileCount = 0;

  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue;
    fileCount++;
    if (fileCount > MAX_FILE_COUNT) {
      throw new Error('Too many files: ' + fileCount + ' (max: ' + MAX_FILE_COUNT + ')');
    }
    totalSize += data.length;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error('Total size exceeds ' + MAX_TOTAL_SIZE / 1024 / 1024 + 'MB limit');
    }
  }

  return { totalSize, fileCount };
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SETUP_ZIP') {
    handleSetupZip(event);
  } else if (event.data?.type === 'CLEANUP_ZIP') {
    zipStores.delete(event.data.postId);
  }
});

function handleSetupZip(event) {
  const { postId, zipData } = event.data;
  if (!postId || !zipData) {
    event.source?.postMessage({ type: 'ZIP_ERROR', postId, error: 'Invalid params' });
    return;
  }

  cleanupExpired();

  if (zipStores.has(postId)) {
    event.source?.postMessage({ type: 'ZIP_READY', postId, fileCount: zipStores.get(postId).files.size });
    return;
  }

  try {
    const data = new Uint8Array(zipData);
    if (data.byteLength > MAX_TOTAL_SIZE) {
      throw new Error('ZIP file exceeds size limit');
    }

    const files = fflate.unzipSync(data);
    validateZipContent(files);

    const fileMap = new Map();
    let hasIndex = false;

    for (const [path, content] of Object.entries(files)) {
      if (path.endsWith('/')) continue;
      const normalizedPath = '/' + path;
      if (validatePath(normalizedPath)) {
        fileMap.set(normalizedPath, content);
        const fileName = path.split('/').pop()?.toLowerCase();
        if (fileName === 'index.html' || fileName === 'index.htm') {
          hasIndex = true;
        }
      }
    }

    if (!hasIndex) {
      throw new Error('index.html not found in zip');
    }

    zipStores.set(postId, { files: fileMap, createdAt: Date.now() });

    event.source?.postMessage({ type: 'ZIP_READY', postId, fileCount: fileMap.size, files: [...fileMap.keys()] });
  } catch (err) {
    zipStores.delete(postId);
    event.source?.postMessage({ type: 'ZIP_ERROR', postId, error: err.message });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/sw-zip\/([^/]+)(\/.*)?$/);
  if (!match) return;

  const postId = match[1];
  let filePath = match[2] || '/index.html';
  if (filePath === '/') filePath = '/index.html';

  event.respondWith(serveFromFS(postId, filePath));
});

async function serveFromFS(postId, filePath) {
  const store = zipStores.get(postId);
  if (!store) {
    return new Response('ZIP store not found for post: ' + postId, {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  let data = store.files.get(filePath);
  if (!data) {
    data = store.files.get(filePath.replace(/\/?$/, '/index.html'));
  }
  if (!data && filePath.startsWith('/')) {
    data = store.files.get(filePath.substring(1));
  }

  if (!data) {
    const fallbacks = [filePath + '/index.html', filePath.replace(/\/$/, '')];
    for (const fb of fallbacks) {
      data = store.files.get(fb);
      if (data) break;
    }
  }

  if (!data) {
    const fileName = filePath.split('/').pop()?.toLowerCase();
    if (fileName === 'index.html' || fileName === 'index.htm') {
      let bestKey = null;
      let bestDepth = Infinity;
      for (const key of store.files.keys()) {
        const parts = key.split('/');
        const name = parts.pop()?.toLowerCase();
        if (name === 'index.html' || name === 'index.htm') {
          const depth = parts.length;
          if (depth < bestDepth) {
            bestDepth = depth;
            bestKey = key;
          }
        }
      }
      if (bestKey) {
        data = store.files.get(bestKey);
        filePath = bestKey;
      }
    }
  }

  if (!data) {
    return new Response('404 Not Found: ' + filePath, { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  const ext = filePath.split('.').pop()?.toLowerCase();
  const contentType = EXT_CONFIG['.' + ext] || 'application/octet-stream';

  if (ext === 'html') {
    const html = new TextDecoder().decode(data);
    const baseHref = '/sw-zip/' + postId + '/';
    const modified = html.includes('<head>')
      ? html.replace('<head>', '<head>\n  <base href="' + baseHref + '">')
      : '<base href="' + baseHref + '">\n' + html;
    data = new TextEncoder().encode(modified);
  }

  return new Response(data, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    },
  });
}
