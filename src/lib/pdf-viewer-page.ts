import { PDFJS_MAIN_MJS, PDFJS_WORKER_MJS } from './pdfjs.generated.ts';

/**
 * The PDF viewer page served on the sandbox origin (`sandbox.flaxia.app` is a
 * Worker — see `wrangler.sandbox.toml`) and, for local development, by the
 * Vite dev server middleware in `vite.config.ts`.
 *
 * Rendering pdf.js inside this page — rather than in the browser's built-in
 * PDF plugin — is the whole point: a plugin document cannot be shown in a
 * sandboxed frame at all (the HTML spec sets the sandboxed plugins browsing
 * context flag with no token to unset it, whatwg/html#6946), and running an
 * untrusted document parser inside the main origin would turn any pdf.js bug
 * into a site-wide XSS (CVE-2024-4367 is the precedent).
 *
 * Data flows over the typed bridge (`src/lib/bridge.ts`): the frame posts
 * DOCUMENT_READY, the parent sends the R2 bytes as DOCUMENT_DATA, and the
 * frame asks for VIEWER_DOWNLOAD / reports VIEWER_CLOSE. The parent never
 * loads a frame src with content in it — `/api/documents/*` stays same-origin
 * on the parent side and the bytes are transferred across.
 *
 * The HTML is one self-contained document (inline style + inline module) so
 * the Worker route needs a single response and no asset pipeline: CSP
 * `script-src 'self' 'unsafe-inline'` on the sandbox Worker covers it, and
 * pdf.js itself is imported lazily from `/pdf/pdfjs.mjs` only once a
 * document actually arrives. Keep the inline script free of backticks and
 * `${` — it lives inside this template literal.
 */
export const PDF_VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Document viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    display: flex;
    flex-direction: column;
    background: #15171c;
    color: #e6e8ee;
    font-family: "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overflow: hidden;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex: 0 0 auto;
    padding: 0.4rem 0.6rem;
    background: #1c1f26;
    border-bottom: 1px solid #2a2e38;
    font-size: 0.8rem;
    user-select: none;
  }
  .toolbar button {
    background: transparent;
    color: inherit;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 0.3rem 0.55rem;
    font: inherit;
    line-height: 1;
    cursor: pointer;
  }
  .toolbar button:hover:not(:disabled) { background: #2a2e38; border-color: #3a3f4b; }
  .toolbar button:disabled { opacity: 0.35; cursor: default; }
  .sep { color: #565c6a; padding: 0 0.2rem; }
  .grow { flex: 1 1 auto; }
  .indicator {
    min-width: 4.5rem;
    text-align: center;
    color: #b9bfcc;
    font-variant-numeric: tabular-nums;
  }
  .stage {
    flex: 1 1 auto;
    overflow: auto;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 12px;
  }
  .stage canvas {
    display: none;
    background: #fff;
    box-shadow: 0 2px 14px rgba(0, 0, 0, 0.55);
    max-width: none;
  }
  .stage canvas.visible { display: block; }
  .status {
    position: fixed;
    left: 0;
    right: 0;
    top: 46%;
    text-align: center;
    color: #9aa1b0;
    font-size: 0.875rem;
    padding: 0 1.25rem;
    pointer-events: none;
  }
  .status.error { color: #ff8b93; }
  .status.hidden { display: none; }
</style>
</head>
<body>
<div class="toolbar" role="toolbar">
  <button id="prev" type="button">&#8249;</button>
  <span class="indicator" id="indicator">&#8211; / &#8211;</span>
  <button id="next" type="button">&#8250;</button>
  <span class="sep">|</span>
  <button id="zoomOut" type="button">&#8722;</button>
  <span class="indicator" id="zoomLabel">100%</span>
  <button id="zoomIn" type="button">+</button>
  <span class="grow"></span>
  <button id="download" type="button">&#8595;</button>
  <button id="close" type="button">&#10005;</button>
</div>
<div class="stage" id="stage"><canvas id="canvas"></canvas></div>
<div class="status" id="status"></div>
<script type="module">
const STRINGS = {
  en: {
    title: 'Document viewer',
    loading: 'Loading…',
    fail: 'This document could not be displayed.',
    pwd: 'Password-protected documents are not supported.',
    empty: 'This document has no pages.',
    prev: 'Previous page',
    next: 'Next page',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    download: 'Download',
    close: 'Close viewer',
  },
  ja: {
    title: 'ドキュメントビューア',
    loading: '読み込み中…',
    fail: 'このドキュメントを表示できませんでした。',
    pwd: 'パスワード保護されたドキュメントには対応していません。',
    empty: 'ページがありません。',
    prev: '前のページ',
    next: '次のページ',
    zoomIn: '拡大',
    zoomOut: '縮小',
    download: 'ダウンロード',
    close: 'ビューアを閉じる',
  },
};
const lang = new URLSearchParams(location.search).get('lang') === 'ja' ? 'ja' : 'en';
const s = STRINGS[lang];
document.documentElement.lang = lang;
document.title = s.title;

function setLabel(id, text) {
  const el = document.getElementById(id);
  el.setAttribute('aria-label', text);
  el.title = text;
}
setLabel('prev', s.prev);
setLabel('next', s.next);
setLabel('zoomIn', s.zoomIn);
setLabel('zoomOut', s.zoomOut);
setLabel('download', s.download);
setLabel('close', s.close);

const stage = document.getElementById('stage');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');
const indicator = document.getElementById('indicator');
const zoomLabel = document.getElementById('zoomLabel');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomInBtn = document.getElementById('zoomIn');
const downloadBtn = document.getElementById('download');

let pdfjs = null;
let doc = null;
let pageNum = 1;
let numPages = 0;
let zoom = 1;
let rendering = false;
let rerender = false;

const requestId =
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + String(Math.random()).slice(2);

function send(message) {
  window.parent.postMessage(message, '*');
}

function showStatus(text, isError) {
  status.textContent = text;
  status.className = 'status' + (isError ? ' error' : '');
}

function hideStatus() {
  status.className = 'status hidden';
}

function updateToolbar() {
  indicator.textContent = numPages ? pageNum + ' / ' + numPages : '\\u2013 / \\u2013';
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  prevBtn.disabled = !doc || pageNum <= 1;
  nextBtn.disabled = !doc || pageNum >= numPages;
  zoomOutBtn.disabled = !doc || zoom <= 0.5;
  zoomInBtn.disabled = !doc || zoom >= 4;
  downloadBtn.disabled = !doc;
}

function baseScale(page) {
  const viewport = page.getViewport({ scale: 1 });
  const available = Math.max(240, stage.clientWidth - 24);
  return available / viewport.width;
}

async function renderPage() {
  if (!doc) return;
  if (rendering) {
    rerender = true;
    return;
  }
  rendering = true;
  try {
    const page = await doc.getPage(pageNum);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: baseScale(page) * zoom * dpr });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
    canvas.style.height = Math.floor(viewport.height / dpr) + 'px';
    await page.render({ canvasContext: ctx, viewport }).promise;
    canvas.className = 'visible';
    hideStatus();
    updateToolbar();
  } catch (err) {
    showStatus(s.fail, true);
    if (typeof console !== 'undefined') console.error('pdf.js render failed', err);
  } finally {
    rendering = false;
    if (rerender) {
      rerender = false;
      void renderPage();
    }
  }
}

async function openDocument(bytes) {
  showStatus(s.loading, false);
  try {
    if (!pdfjs) {
      pdfjs = await import('/pdf/pdfjs.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.mjs';
    }
    const task = pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    doc = await task.promise;
    numPages = doc.numPages;
    pageNum = 1;
    zoom = 1;
    updateToolbar();
    if (!numPages) {
      showStatus(s.empty, true);
      return;
    }
    await renderPage();
  } catch (err) {
    doc = null;
    numPages = 0;
    updateToolbar();
    const isPassword = !!err && err.name === 'PasswordException';
    showStatus(isPassword ? s.pwd : s.fail, true);
    if (typeof console !== 'undefined') console.error('pdf.js open failed', err);
  }
}

function goTo(delta) {
  if (!doc) return;
  const next = pageNum + delta;
  if (next < 1 || next > numPages) return;
  pageNum = next;
  void renderPage();
}

function setZoom(next) {
  if (!doc) return;
  zoom = Math.min(4, Math.max(0.5, next));
  void renderPage();
}

prevBtn.addEventListener('click', () => goTo(-1));
nextBtn.addEventListener('click', () => goTo(1));
zoomOutBtn.addEventListener('click', () => setZoom(zoom / 1.25));
zoomInBtn.addEventListener('click', () => setZoom(zoom * 1.25));
downloadBtn.addEventListener('click', () => send({ type: 'VIEWER_DOWNLOAD', requestId: requestId }));
document.getElementById('close').addEventListener('click', () =>
  send({ type: 'VIEWER_CLOSE', requestId: requestId }),
);

document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault();
    goTo(-1);
  } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
    event.preventDefault();
    goTo(1);
  } else if (event.key === 'Escape') {
    send({ type: 'VIEWER_CLOSE', requestId: requestId });
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!doc) return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void renderPage(), 150);
});

// Bytes arrive from the parent over the bridge; only the parent window may
// supply them (the frame itself is opaque-origin, so no origin string check
// is possible — the source window is the unforgeable part).
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.type !== 'DOCUMENT_DATA' || data.requestId !== requestId) return;
  void openDocument(data.bytes);
});

updateToolbar();
showStatus(s.loading, false);
send({ type: 'DOCUMENT_READY', requestId: requestId });
</script>
</body>
</html>
`;

/** Content-type / caching headers for one `/pdf/*` asset, or null if unknown. */
export function pdfViewerAssetHeaders(asset: string): Record<string, string> | null {
  switch (asset) {
    case 'viewer':
      return { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
    case 'pdfjs.mjs':
    case 'pdf.worker.mjs':
      return { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' };
    default:
      return null;
  }
}

/** Body for one `/pdf/*` asset, or null if unknown. */
export function pdfViewerAssetBody(asset: string): string | null {
  switch (asset) {
    case 'viewer':
      return PDF_VIEWER_HTML;
    case 'pdfjs.mjs':
      return PDFJS_MAIN_MJS;
    case 'pdf.worker.mjs':
      return PDFJS_WORKER_MJS;
    default:
      return null;
  }
}
