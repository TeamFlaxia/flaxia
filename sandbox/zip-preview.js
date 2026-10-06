import {
  isParentZipPreviewMessage,
  isPreviewFullscreenRequest,
  isSandboxZipPreviewMessage,
} from './zip-preview-protocol.js';

const container = document.getElementById('container');
const loading = document.getElementById('loading');
const errorEl = document.getElementById('error');

const ALLOWED_EXTENSIONS = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.glsl': 'text/plain',
  '.wgsl': 'text/plain',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.map': 'application/json',
  '.dat': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

function showError(msg) {
  loading.style.display = 'none';
  errorEl.textContent = msg;
  errorEl.style.display = 'block';
}

function shouldRewritePath(path) {
  return (
    !path.startsWith('https://') &&
    !path.startsWith('http://') &&
    !path.startsWith('data:') &&
    !path.startsWith('blob:')
  );
}

function resolveArchiveUrl(path, basePath) {
  if (!path || !shouldRewritePath(path) || path.startsWith('#') || path.startsWith('?')) return null;
  try {
    const baseUrl = new URL(basePath, 'https://zip.invalid/');
    const resolved = new URL(path, baseUrl);
    if (resolved.origin !== 'https://zip.invalid') return null;
    return {
      path: decodeURIComponent(resolved.pathname.slice(1)),
      suffix: resolved.search + resolved.hash,
    };
  } catch {
    return null;
  }
}

function getBlobUrl(path, blobUrlMap, basePath) {
  const resolved = resolveArchiveUrl(path, basePath);
  if (!resolved) return null;
  const blobUrl = blobUrlMap.get(resolved.path);
  return blobUrl ? blobUrl + resolved.suffix : null;
}

function rewriteCssUrls(cssText, blobUrlMap, basePath) {
  cssText = cssText.replace(/url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, path) => {
    const blobUrl = getBlobUrl(path, blobUrlMap, basePath);
    return blobUrl ? 'url("' + blobUrl + '")' : match;
  });
  return cssText.replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, path) => {
    const blobUrl = getBlobUrl(path, blobUrlMap, basePath);
    return blobUrl ? '@import url("' + blobUrl + '")' : match;
  });
}

function rewriteHtmlString(htmlContent, blobUrlMap) {
  htmlContent = htmlContent.replace(/<([^>]+)\s+src\s*=\s*['"]([^'"]+)['"]/gi, (match, tagAttrs, src) => {
    const blobUrl = getBlobUrl(src, blobUrlMap, 'index.html');
    return blobUrl ? '<' + tagAttrs + ' src="' + blobUrl + '"' : match;
  });

  htmlContent = htmlContent.replace(/<([^>]+)\s+href\s*=\s*['"]([^'"]+)['"]/gi, (match, tagAttrs, href) => {
    const blobUrl = getBlobUrl(href, blobUrlMap, 'index.html');
    return blobUrl ? '<' + tagAttrs + ' href="' + blobUrl + '"' : match;
  });

  htmlContent = htmlContent.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, cssContent) => {
    const rewrittenCss = rewriteCssUrls(cssContent, blobUrlMap, 'index.html');
    return match.replace(cssContent, rewrittenCss);
  });

  htmlContent = htmlContent.replace(/style\s*=\s*['"]([^'"]+)['"]/gi, (match, styleContent) => {
    const rewrittenStyle = rewriteCssUrls(styleContent, blobUrlMap, 'index.html');
    return 'style="' + rewrittenStyle + '"';
  });

  return htmlContent;
}

function validateZip(zip) {
  const files = Object.entries(zip.files);

  if (files.length > 255) {
    throw new Error('Too many files (max 255)');
  }

  let totalSize = 0;
  let hasIndexHtml = false;

  for (const [path, file] of files) {
    if (file.dir) continue;

    if (path.length > 255) {
      throw new Error(`Path too long: ${path}`);
    }

    const depth = (path.match(/\//g) || []).length;
    if (depth > 10) {
      throw new Error(`Directory too deep: ${path}`);
    }

    const fileSize = file._data?.uncompressedSize || 0;
    totalSize += fileSize;
    if (totalSize > 100 * 1024 * 1024) {
      throw new Error('Extracted size too large (max 100MB)');
    }

    if (path.toLowerCase().endsWith('.zip')) {
      throw new Error('Nested ZIP files are not allowed');
    }

    const unixPermissions = file.unixPermissions;
    if (unixPermissions && (unixPermissions & 0xf000) === 0xa000) {
      throw new Error('Symbolic links are not allowed');
    }

    if (path.includes('\\') || path.split('/').some((segment) => segment === '..')) {
      throw new Error('Path traversal or ambiguous separators are not allowed');
    }

    if (path.startsWith('/') || /^[a-z]:/i.test(path)) {
      throw new Error('Absolute paths are not allowed');
    }

    if (path === 'index.html') {
      hasIndexHtml = true;
    }

    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS[ext]) {
      throw new Error(`File type not allowed: ${path}`);
    }
  }

  if (!hasIndexHtml) {
    throw new Error('index.html not found at root');
  }
}

async function generateBlobUrlMap(zip) {
  const blobUrlMap = new Map();
  const cssFiles = [];

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;

    const normalizedPath = path.replace(/^\.\//, '');
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
    const mimeType = ALLOWED_EXTENSIONS[ext];
    if (!mimeType) continue;

    if (ext === '.css') {
      cssFiles.push({ path: normalizedPath, content: await file.async('string') });
      continue;
    }

    const content = await file.async('uint8array');
    const arrayBuffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    const blobUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: mimeType }));
    blobUrlMap.set(normalizedPath, blobUrl);
  }

  for (const cssFile of cssFiles) {
    const rewrittenCss = rewriteCssUrls(cssFile.content, blobUrlMap, cssFile.path);
    const blobUrl = URL.createObjectURL(new Blob([rewrittenCss], { type: 'text/css' }));
    blobUrlMap.set(cssFile.path, blobUrl);
  }

  return blobUrlMap;
}

async function loadJSZip() {
  if (!window.JSZip) {
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js';
    script.integrity = 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG';
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load JSZip'));
      document.head.appendChild(script);
    });
  }
  return window.JSZip;
}

async function executeZip(zipData) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(zipData);
  validateZip(zip);
  const blobUrlMap = await generateBlobUrlMap(zip);

  const indexFile = zip.files['index.html'];
  if (!indexFile || indexFile.dir) {
    throw new Error('index.html not found at root');
  }

  let htmlContent = await indexFile.async('string');
  htmlContent = rewriteHtmlString(htmlContent, blobUrlMap);

  const htmlBlob = new Blob([htmlContent], { type: 'text/html' });
  const htmlBlobUrl = URL.createObjectURL(htmlBlob);

  const iframe = document.createElement('iframe');
  iframe.src = htmlBlobUrl;
  iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-forms allow-popups');
  iframe.setAttribute('allow', 'fullscreen; web-share');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = `
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  `;

  container.innerHTML = '';
  container.appendChild(iframe);

  return { iframe, blobUrlMap, htmlBlobUrl };
}

function isAllowedParentOrigin(origin) {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === 'https:') {
      return parsed.hostname === 'flaxia.app' || parsed.hostname.endsWith('.pages.dev');
    }
    return (
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
      ['5173', '8787', '8788'].includes(parsed.port)
    );
  } catch {
    return false;
  }
}

let initializedFor = null;
let zipHasRun = false;
window.addEventListener('message', async (event) => {
  if (event.source !== window.parent || window.parent === window || !isAllowedParentOrigin(event.origin)) return;
  if (!isSandboxZipPreviewMessage(event.data)) return;
  const replyTo = event.origin;

  if (event.data.type === 'PREVIEW_INIT') {
    if (initializedFor && initializedFor !== event.data.requestId) return;
    initializedFor = event.data.requestId;
    const ready = { type: 'ZIP_PREVIEW_READY', requestId: event.data.requestId };
    if (isParentZipPreviewMessage(ready)) window.parent.postMessage(ready, replyTo);
    return;
  }
  if (event.data.type !== 'EXECUTE_ZIP' || event.data.postId !== initializedFor || zipHasRun) return;
  zipHasRun = true;
  loading.style.display = 'flex';
  errorEl.style.display = 'none';

  try {
    const result = await executeZip(event.data.zipData);
    window.zipCleanup = () => {
      result.blobUrlMap.forEach((url) => void URL.revokeObjectURL(url));
      URL.revokeObjectURL(result.htmlBlobUrl);
    };
    const ready = { type: 'ZIP_READY', postId: event.data.postId };
    if (!isParentZipPreviewMessage(ready)) throw new Error('Invalid ZIP preview response');
    window.parent.postMessage(ready, replyTo);
  } catch (err) {
    const message = (err instanceof Error ? err.message : 'ZIP preview failed').slice(0, 500);
    showError(message);
    const failure = { type: 'ZIP_ERROR', postId: event.data.postId, error: message };
    if (isParentZipPreviewMessage(failure)) window.parent.postMessage(failure, replyTo);
  }
});

window.addEventListener('message', (event) => {
  const gameFrame = container.querySelector('iframe');
  if (event.source !== gameFrame?.contentWindow || event.origin !== 'null') return;
  if (!isPreviewFullscreenRequest(event.data) || !gameFrame?.requestFullscreen) return;
  gameFrame.requestFullscreen().catch(() => {});
});

window.addEventListener('unload', () => {
  if (window.zipCleanup) {
    window.zipCleanup();
  }
});
