import type JSZipType from 'jszip';
import { validateFileType } from './file-extensions';
import { t } from './i18n.js';

export interface ZipExecutorHandle {
  destroy: () => void;
}

const _SANDBOX_ORIGIN = '';
const _SANDBOX_API_ORIGIN = '';

const LOADING_TIMEOUT = 30000;

// Global execution manager
let activeHandle: ZipExecutorHandle | null = null;

// Cache for dynamic imports
let jszipPromise: Promise<{ default: JSZipType }> | null = null;

async function getJSZip(): Promise<JSZipType> {
  if (!jszipPromise) {
    jszipPromise = import('jszip') as Promise<{ default: JSZipType }>;
  }
  const JSZipModule = await jszipPromise;
  return JSZipModule.default;
}

export async function executeZip(
  postId: string,
  containerEl: HTMLElement,
  url?: string, // if provided, fetch from this URL instead of /api/zip/${postId}
): Promise<ZipExecutorHandle> {
  if (activeHandle) {
    activeHandle.destroy();
    activeHandle = null;
  }

  try {
    containerEl.innerHTML = '';
    containerEl.style.position = 'relative';

    const loadingEl = createZipLoadingIndicator();
    containerEl.appendChild(loadingEl);

    const zipUrl = url || `/api/zip/${postId}`;
    const response = await fetch(zipUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch ZIP: ${response.status}`);
    }
    const zipData = await response.arrayBuffer();

    const JSZip = await getJSZip();
    const zip = await JSZip.loadAsync(zipData);
    validateZip(zip);

    const blobUrlMap = await generateBlobUrlMap(zip);
    const htmlContent = await rewriteIndexHtml(zip, blobUrlMap);

    const htmlBlob = new Blob([htmlContent], { type: 'text/html' });
    const htmlBlobUrl = URL.createObjectURL(htmlBlob);

    const { iframe, cleanup } = createSandboxIframe(containerEl, htmlBlobUrl);

    const loaded = await waitForLegacyLoad(iframe, loadingEl);

    if (loaded) {
      iframe.style.opacity = '1';
      if (loadingEl.parentNode) {
        loadingEl.style.opacity = '0';
        setTimeout(() => {
          if (loadingEl.parentNode) loadingEl.remove();
        }, 300);
      }
    } else {
      if (loadingEl.parentNode) {
        loadingEl.innerHTML = `<div style="color: var(--text-muted, #64748b); text-align: center; padding: 20px; font-size: 0.875rem;">読み込みに時間がかかっています…</div>`;
      }
      iframe.style.opacity = '1';
    }

    const handle: ZipExecutorHandle = {
      destroy: () => {
        clearTimeout((iframe as HTMLIFrameElement & { _legacyTimeout?: number })._legacyTimeout);
        cleanup();

        blobUrlMap.forEach((u) => void URL.revokeObjectURL(u));
        URL.revokeObjectURL(htmlBlobUrl);

        const fullscreenBtn = containerEl.querySelector('.zip-fullscreen-btn');
        if (fullscreenBtn) {
          fullscreenBtn.parentNode?.removeChild(fullscreenBtn);
        }
      },
    };

    activeHandle = handle;
    return handle;
  } catch (error) {
    if (activeHandle) {
      activeHandle.destroy();
      activeHandle = null;
    }
    throw error;
  }
}

function createZipLoadingIndicator(): HTMLElement {
  ensureSpinKeyframe();

  const loading = document.createElement('div');
  loading.className = 'zip-loading';
  loading.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--bg-primary, #ffffff);
    z-index: 10;
    transition: opacity 0.3s ease;
    border-radius: 8px;
  `;

  const spinner = document.createElement('div');
  spinner.style.cssText = `
    width: 32px;
    height: 32px;
    border: 3px solid var(--border, #e2e8f0);
    border-top-color: var(--accent, #22c55e);
    border-radius: 50%;
    animation: wvfs-spin 0.8s linear infinite;
    margin-bottom: 12px;
  `;

  const text = document.createElement('div');
  text.style.cssText = `
    color: var(--text-muted, #64748b);
    font-size: 0.875rem;
    font-weight: 500;
  `;
  text.textContent = t('post_stage.loading_zip').replace(/<[^>]+>/g, '');

  loading.appendChild(spinner);
  loading.appendChild(text);
  return loading;
}

function createSandboxIframe(
  containerEl: HTMLElement,
  blobUrl: string,
): { iframe: HTMLIFrameElement; cleanup: () => void } {
  const iframeContainer = document.createElement('div');
  iframeContainer.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
  `;

  const iframe = document.createElement('iframe');
  iframe.src = blobUrl;
  iframe.sandbox = 'allow-scripts allow-pointer-lock allow-fullscreen';
  iframe.setAttribute('allow', 'fullscreen');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    opacity: 0;
    transition: opacity 0.3s ease;
  `;

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.textContent = t('fullscreen.button');
  fullscreenBtn.className = 'zip-fullscreen-btn';
  fullscreenBtn.style.cssText = `
    margin-top: 8px;
    padding: 4px 8px;
    font-size: 12px;
    border: 1px solid #ccc;
    background: #f0f0f0;
    cursor: pointer;
    border-radius: 4px;
    align-self: center;
  `;
  fullscreenBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      if (iframeContainer.requestFullscreen) {
        iframeContainer.requestFullscreen().catch((err) => {
          console.warn('Container fullscreen failed:', err);
          if (iframe.requestFullscreen) {
            iframe.requestFullscreen().catch((err2) => {
              console.warn('Iframe fullscreen failed:', err2);
            });
          }
        });
      } else if (iframe.requestFullscreen) {
        iframe.requestFullscreen().catch((err) => {
          console.warn('Iframe fullscreen failed:', err);
        });
      }
    } catch (error) {
      console.error('Fullscreen error:', error);
    }
  };

  containerEl.appendChild(iframeContainer);
  iframeContainer.appendChild(iframe);
  iframeContainer.appendChild(fullscreenBtn);

  const cleanup = () => {
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  };

  return { iframe, cleanup };
}

function waitForLegacyLoad(iframe: HTMLIFrameElement, loadingEl: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    if (iframe.contentWindow?.location?.href && iframe.contentWindow.location.href !== 'about:blank') {
      resolve(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      iframe.removeEventListener('load', onLoad);
      resolve(false);
    }, LOADING_TIMEOUT);

    (iframe as HTMLIFrameElement & { _legacyTimeout?: number })._legacyTimeout = timeoutId;

    function onLoad() {
      clearTimeout(timeoutId);
      resolve(true);
    }

    iframe.addEventListener('load', onLoad, { once: true });
  });
}

function ensureSpinKeyframe(): void {
  if (!document.querySelector('#wvfs-spin-style')) {
    const style = document.createElement('style');
    style.id = 'wvfs-spin-style';
    style.textContent = `@keyframes wvfs-spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
  }
}

export async function rewriteIndexHtmlLegacy(zipData: ArrayBuffer, blobUrlMap: Map<string, string>): Promise<string> {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(zipData);
  return rewriteIndexHtml(zip, blobUrlMap);
}

// Private helper functions (used by legacy functions)
function validateZip(zip: JSZipType): void {
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

    const fileSize = (file as { _data?: { uncompressedSize: number } })._data?.uncompressedSize || 0;
    totalSize += fileSize;
    if (totalSize > 100 * 1024 * 1024) {
      throw new Error('Extracted size too large (max 100MB)');
    }

    if (path.toLowerCase().endsWith('.zip')) {
      throw new Error('Nested ZIP files are not allowed');
    }

    const unixPermissions = file.unixPermissions;
    if (typeof unixPermissions === 'number' && (unixPermissions & 0xf000) === 0xa000) {
      throw new Error('Symbolic links are not allowed');
    }

    if (path.includes('../')) {
      throw new Error(`Path traversal detected: ${path}`);
    }

    if (path.startsWith('/')) {
      throw new Error(`Absolute paths are not allowed: ${path}`);
    }

    if (path === 'index.html') {
      hasIndexHtml = true;
    }

    const { allowed } = validateFileType(path);
    if (!allowed) {
      throw new Error(`File type not allowed: ${path}`);
    }
  }

  if (!hasIndexHtml) {
    throw new Error('index.html not found at root');
  }
}

// Legacy functions kept for backward compatibility (used by tests)
export async function validateZipLegacy(zipData: ArrayBuffer): Promise<void> {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(zipData);
  validateZip(zip);
}

async function generateBlobUrlMap(zip: JSZipType): Promise<Map<string, string>> {
  const blobUrlMap = new Map<string, string>();

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;

    const normalizedPath = path.replace(/^\.\//, '');
    const { mimeType } = validateFileType(path);

    if (mimeType) {
      const content = await file.async('uint8array');
      const arrayBuffer = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([arrayBuffer], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      blobUrlMap.set(normalizedPath, blobUrl);
    }
  }

  return blobUrlMap;
}

async function rewriteIndexHtml(zip: JSZipType, blobUrlMap: Map<string, string>): Promise<string> {
  const indexFile = zip.files['index.html'];
  if (!indexFile || indexFile.dir) {
    throw new Error('index.html not found at root');
  }

  let htmlContent = await indexFile.async('string');
  htmlContent = rewriteHtmlString(htmlContent, blobUrlMap);

  return htmlContent;
}

function rewriteHtmlString(htmlContent: string, blobUrlMap: Map<string, string>): string {
  htmlContent = htmlContent.replace(/<(?!script)([^>]+)\s+src\s*=\s*['"]([^'"]+)['"]/gi, (match, tagAttrs, src) => {
    if (shouldRewritePath(src)) {
      const normalizedPath = src.replace(/^\.\//, '');
      const blobUrl = blobUrlMap.get(normalizedPath);
      if (blobUrl) {
        return `<${tagAttrs} src="${blobUrl}"`;
      }
    }
    return match;
  });

  htmlContent = htmlContent.replace(/<([^>]+)\s+href\s*=\s*['"]([^'"]+)['"]/gi, (match, tagAttrs, href) => {
    if (shouldRewritePath(href)) {
      const normalizedPath = href.replace(/^\.\//, '');
      const blobUrl = blobUrlMap.get(normalizedPath);
      if (blobUrl) {
        return `<${tagAttrs} href="${blobUrl}"`;
      }
    }
    return match;
  });

  htmlContent = htmlContent.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, cssContent) => {
    const rewrittenCss = rewriteCssUrls(cssContent, blobUrlMap);
    return match.replace(cssContent, rewrittenCss);
  });

  htmlContent = htmlContent.replace(/style\s*=\s*['"]([^'"]+)['"]/gi, (match, styleContent) => {
    const rewrittenStyle = rewriteCssUrls(styleContent, blobUrlMap);
    return `style="${rewrittenStyle}"`;
  });

  return htmlContent;
}

function rewriteCssUrls(cssText: string, blobUrlMap: Map<string, string>): string {
  return cssText.replace(/url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/g, (match, path) => {
    if (shouldRewritePath(path)) {
      const normalizedPath = path.replace(/^\.\//, '');
      const blobUrl = blobUrlMap.get(normalizedPath);
      if (blobUrl) {
        return `url("${blobUrl}")`;
      }
    }
    return match;
  });
}

function shouldRewritePath(path: string): boolean {
  return (
    !path.startsWith('https://') &&
    !path.startsWith('http://') &&
    !path.startsWith('data:') &&
    !path.startsWith('blob:')
  );
}
