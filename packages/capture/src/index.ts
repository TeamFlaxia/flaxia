/**
 * Capture bridge for Flaxia sandbox games.
 *
 * This script is injected into served game HTML (WVFS ZIP / HTML5 / DOS player)
 * and runs inside the sandbox origin. Because games run in cross-origin iframes
 * without `allow-same-origin`, the parent cannot read the game canvas directly;
 * this bridge captures frames in the sandbox and ships them to the parent via
 * postMessage.
 *
 * It exposes three request/response pairs:
 *  - CAPTURE_INIT        (parent -> game) handshake, starts the rolling buffer
 *  - CAPTURE_READY       (game -> parent) reports whether a canvas was found
 *  - CAPTURE_FRAME       (parent -> game) capture a single PNG frame
 *  - CAPTURE_FRAME_RESULT(game -> parent) PNG frame (ArrayBuffer)
 *  - CAPTURE_GIF         (parent -> game) export the rolling buffer
 *  - CAPTURE_GIF_RESULT  (game -> parent) raw RGBA frames for GIF encoding
 *  - CAPTURE_ERROR       (game -> parent) capture failure
 *
 * When the game uses several canvases (background + foreground layers, or a
 * game + HUD overlay), they are composited into one frame by layout position
 * and DOM order. Tainted canvases are skipped rather than blanking the whole
 * capture.
 *
 * All frames are downscaled to a max width and stored in a rolling ring buffer
 * of roughly `BUFFER_MS` seconds so the parent can request "the last N seconds"
 * with a single tap.
 */

const BUFFER_MS = 4000;
const SAMPLE_MS = 150; // ~6.7 fps
const MAX_WIDTH = 360;

// WebGL canvases default to preserveDrawingBuffer:false, which clears the
// drawing buffer once it is composited. Reading pixels (toBlob/drawImage)
// outside the render loop then yields an all-black frame. The bridge runs
// before game scripts (injected at <head>), so we can force the flag on at
// context creation to make captures show the actual game image. The same patch
// is applied to OffscreenCanvas, and canvases that were handed off via
// transferControlToOffscreen() are tracked so the composite can draw from the
// OffscreenCanvas instead of the (unreadable) placeholder element.
const webglContexts = new Set<WebGLRenderingContext | WebGL2RenderingContext>();
const offscreenMap = new WeakMap<HTMLCanvasElement, OffscreenCanvas>();

function trackWebGLContext(context: unknown): void {
  if (context && typeof (context as { finish?: unknown }).finish === 'function') {
    webglContexts.add(context as WebGLRenderingContext | WebGL2RenderingContext);
  }
}

// Make sure the latest frame has been fully presented before reading pixels;
// otherwise drawImage may capture a half-rendered or cleared buffer.
function syncWebGLContexts(): void {
  for (const ctx of webglContexts) {
    try {
      ctx.finish();
    } catch {
      // Context lost or moved to a worker — nothing to sync.
    }
  }
}

function resolveCanvasSource(canvas: HTMLCanvasElement): HTMLCanvasElement | OffscreenCanvas {
  return offscreenMap.get(canvas) ?? canvas;
}

{
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
    options?: Record<string, unknown>,
  ): RenderingContext | null {
    if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') {
      options = { ...options, preserveDrawingBuffer: true };
    }
    const ctx = originalGetContext.call(this, contextId, options);
    if (ctx) trackWebGLContext(ctx);
    return ctx;
  } as typeof HTMLCanvasElement.prototype.getContext;

  const originalTransfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
  if (typeof originalTransfer === 'function') {
    HTMLCanvasElement.prototype.transferControlToOffscreen = function (this: HTMLCanvasElement) {
      const offscreen = originalTransfer.call(this);
      if (offscreen) offscreenMap.set(this, offscreen);
      return offscreen;
    } as typeof HTMLCanvasElement.prototype.transferControlToOffscreen;
  }

  const OffscreenCanvasCtor = (typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : undefined) as
    | typeof OffscreenCanvas
    | undefined;
  if (OffscreenCanvasCtor && typeof OffscreenCanvasCtor.prototype.getContext === 'function') {
    const originalOffscreenGetContext = OffscreenCanvasCtor.prototype.getContext as (
      this: OffscreenCanvas,
      contextId: string,
      options?: Record<string, unknown>,
    ) =>
      | OffscreenCanvasRenderingContext2D
      | ImageBitmapRenderingContext
      | WebGLRenderingContext
      | WebGL2RenderingContext
      | null;
    OffscreenCanvasCtor.prototype.getContext = function (
      this: OffscreenCanvas,
      contextId: string,
      options?: Record<string, unknown>,
    ) {
      if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') {
        options = { ...options, preserveDrawingBuffer: true };
      }
      const ctx = originalOffscreenGetContext.call(this, contextId, options);
      if (ctx) trackWebGLContext(ctx);
      return ctx;
    } as typeof OffscreenCanvasCtor.prototype.getContext;
  }
}

interface BufferedFrame {
  ts: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface CanvasPlacement {
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAME_CANVAS_SELECTORS = ['#dos-container canvas', '#flash-player canvas', 'canvas'];

// Canvases are cached between taint probes: a canvas rarely flips between
// tainted/clean mid-session, and re-reading every sample would be expensive.
const taintedCanvases = new WeakSet<HTMLCanvasElement>();
const cleanCanvases = new WeakSet<HTMLCanvasElement>();

function findAllGameCanvases(): HTMLCanvasElement[] {
  const seen = new Set<HTMLCanvasElement>();
  for (const selector of GAME_CANVAS_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLCanvasElement>(selector)) {
      if (el.width > 0 && el.height > 0 && !seen.has(el)) seen.add(el);
    }
  }
  return Array.from(seen);
}

function findGameCanvas(): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  for (const el of findAllGameCanvases()) {
    const area = el.width * el.height;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

function getCanvasPlacement(canvas: HTMLCanvasElement): CanvasPlacement {
  const rect = canvas.getBoundingClientRect();
  return {
    canvas,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function documentOrder(a: Element, b: Element): number {
  if (a === b) return 0;
  const position = a.compareDocumentPosition(b);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function isCanvasTainted(canvas: HTMLCanvasElement): boolean {
  if (taintedCanvases.has(canvas)) return true;
  if (cleanCanvases.has(canvas)) return false;
  const source = resolveCanvasSource(canvas);
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const pctx = probe.getContext('2d');
    if (!pctx) return false;
    pctx.drawImage(source, 0, 0, 1, 1);
    pctx.getImageData(0, 0, 1, 1);
    cleanCanvases.add(canvas);
    return false;
  } catch {
    taintedCanvases.add(canvas);
    return true;
  }
}

// Composite every game canvas into a single frame. Canvases are placed by
// their layout rect (union-bounded) and drawn in DOM order so stacked layers
// (background + foreground, game + HUD) blend correctly. The composite keeps
// the largest canvas at its native resolution; siblings are scaled relative
// to it. Tainted canvases (cross-origin images without CORS) are skipped so
// one bad layer can't blank the whole capture. `sync` forces WebGL contexts to
// present before reading (only used for one-shot screenshots, not the rolling
// buffer, where a blocking finish() every sample would be wasteful).
function composeCanvases(placements: CanvasPlacement[], sync = false): HTMLCanvasElement | null {
  const composed = renderComposite(placements, sync);
  if (composed) return composed;
  // Fallback for canvases with a zero-size layout box (e.g. display:none):
  // position them by intrinsic size at the origin.
  if (placements.length > 0) {
    return renderComposite(
      placements.map((p) => ({
        canvas: p.canvas,
        left: 0,
        top: 0,
        width: p.canvas.width,
        height: p.canvas.height,
      })),
      sync,
    );
  }
  return null;
}

function renderComposite(placements: CanvasPlacement[], sync = false): HTMLCanvasElement | null {
  let minLeft = Infinity;
  let minTop = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  for (const p of placements) {
    if (p.width <= 0 || p.height <= 0) continue;
    minLeft = Math.min(minLeft, p.left);
    minTop = Math.min(minTop, p.top);
    maxRight = Math.max(maxRight, p.left + p.width);
    maxBottom = Math.max(maxBottom, p.top + p.height);
  }
  if (!Number.isFinite(minLeft) || maxRight <= minLeft || maxBottom <= minTop) return null;

  const unionWidth = maxRight - minLeft;
  const unionHeight = maxBottom - minTop;

  let scale = 1;
  let largestArea = 0;
  for (const p of placements) {
    if (p.width <= 0 || p.height <= 0) continue;
    const area = p.canvas.width * p.canvas.height;
    if (area > largestArea) {
      largestArea = area;
      scale = p.canvas.width / p.width;
    }
  }
  if (scale <= 0 || !Number.isFinite(scale)) return null;
  scale = Math.min(scale, 4);

  const width = Math.max(1, Math.round(unionWidth * scale));
  const height = Math.max(1, Math.round(unionHeight * scale));

  const composite = document.createElement('canvas');
  composite.width = width;
  composite.height = height;
  const ctx = composite.getContext('2d');
  if (!ctx) return null;

  const sorted = placements
    .filter((p) => p.width > 0 && p.height > 0)
    .sort((a, b) => documentOrder(a.canvas, b.canvas));

  if (sync) syncWebGLContexts();

  let drawn = 0;
  for (const p of sorted) {
    if (isCanvasTainted(p.canvas)) continue;
    const source = resolveCanvasSource(p.canvas);
    const dx = (p.left - minLeft) * scale;
    const dy = (p.top - minTop) * scale;
    try {
      ctx.drawImage(source, dx, dy, source.width, source.height);
      drawn++;
    } catch {
      // Unreadable layer — skip.
    }
  }
  if (drawn === 0) return null;
  return composite;
}

function getCanvasPlacements(): CanvasPlacement[] {
  return findAllGameCanvases().map((c) => getCanvasPlacement(c));
}

function drawScaled(source: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement | null {
  try {
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    if (!octx) return null;
    octx.drawImage(source, 0, 0, w, h);
    return off;
  } catch {
    return null;
  }
}

function run(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let canvas: HTMLCanvasElement | null = findGameCanvas();
  let parentOrigin: string | null = null;
  let parentWindow: Window | null = null;
  let buffer: BufferedFrame[] = [];
  let sampler: number | null = null;
  let readySent = false;
  let canvasChecker: number | null = null;

  function send(message: Record<string, unknown>, transfer?: Transferable[]): void {
    if (!parentWindow) return;
    // Opaque-origin frames report origin as the literal string "null",
    // which postMessage rejects as a targetOrigin — fall back to '*'.
    const target = parentOrigin === 'null' ? '*' : parentOrigin || '*';
    try {
      parentWindow.postMessage(message, target, transfer);
    } catch {
      try {
        parentWindow.postMessage(message, target);
      } catch {
        // ignore
      }
    }
  }

  function sampleNow(): void {
    const composite = composeCanvases(getCanvasPlacements());
    if (!composite) return;
    const w = composite.width;
    const h = composite.height;
    if (!w || !h) return;

    const scale = Math.min(1, MAX_WIDTH / w);
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));

    const off = drawScaled(composite, sw, sh);
    if (!off) return;
    const octx = off.getContext('2d');
    if (!octx) return;
    try {
      const image = octx.getImageData(0, 0, sw, sh);
      buffer.push({ ts: performance.now(), width: sw, height: sh, data: image.data });
    } catch {
      // Tainted canvas (e.g. cross-origin images without CORS) — skip frame.
    }

    // Trim frames older than the buffer window.
    const cutoff = performance.now() - BUFFER_MS;
    while (buffer.length > 0 && buffer[0].ts < cutoff) buffer.shift();
  }

  function startSampling(): void {
    if (sampler !== null) return;
    sampleNow();
    sampler = window.setInterval(sampleNow, SAMPLE_MS);
    window.setTimeout(sampleNow, 0);
  }

  function stopSampling(): void {
    if (sampler !== null) {
      window.clearInterval(sampler);
      sampler = null;
    }
  }

  function checkCanvas(): void {
    if (!canvas) canvas = findGameCanvas();
    if (canvas && !readySent) {
      readySent = true;
      startSampling();
      send({ type: 'CAPTURE_READY', ok: true });
      if (canvasChecker !== null) {
        window.clearInterval(canvasChecker);
        canvasChecker = null;
      }
    }
  }

  function handleReadyInit(): void {
    canvas = findGameCanvas();
    if (canvas) {
      readySent = true;
      startSampling();
    } else if (canvasChecker === null) {
      // Games (especially DOS) may create their canvas after boot; poll for it.
      canvasChecker = window.setInterval(checkCanvas, 500);
      window.setTimeout(() => {
        if (canvasChecker !== null) {
          window.clearInterval(canvasChecker);
          canvasChecker = null;
        }
      }, 30000);
    }
  }

  function requestFrame(requestId: string): void {
    const placements = getCanvasPlacements();
    if (placements.length === 0) {
      send({ type: 'CAPTURE_ERROR', requestId, message: 'no-canvas' });
      return;
    }
    const composite = composeCanvases(placements, true);
    if (!composite) {
      send({ type: 'CAPTURE_ERROR', requestId, message: 'no-valid-canvas' });
      return;
    }
    try {
      composite.toBlob((blob) => {
        if (!blob) {
          send({ type: 'CAPTURE_ERROR', requestId, message: 'toBlob-failed' });
          return;
        }
        blob.arrayBuffer().then(
          (data) => {
            send({ type: 'CAPTURE_FRAME_RESULT', requestId, mime: blob.type || 'image/png', data }, [data]);
          },
          () => {
            send({ type: 'CAPTURE_ERROR', requestId, message: 'arrayBuffer-failed' });
          },
        );
      }, 'image/png');
    } catch (error) {
      send({
        type: 'CAPTURE_ERROR',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function requestGif(requestId: string): void {
    if (buffer.length === 0) {
      send({ type: 'CAPTURE_ERROR', requestId, message: 'no-frames' });
      return;
    }
    const frames = buffer.map((f) => ({
      width: f.width,
      height: f.height,
      ts: f.ts,
      data: f.data.slice().buffer,
    }));
    buffer = [];
    send(
      { type: 'CAPTURE_GIF_RESULT', requestId, frames },
      frames.map((f) => f.data as ArrayBuffer),
    );
  }

  function handleMessage(event: MessageEvent): void {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const type = typeof data.type === 'string' ? data.type : '';

    // Only accept commands from the parent that initiated the handshake,
    // or the initial handshake itself.
    if (type === 'CAPTURE_INIT') {
      parentOrigin = event.origin || '*';
      parentWindow = event.source as Window | null;
      handleReadyInit();
      send({ type: 'CAPTURE_READY', ok: !!canvas });
      return;
    }

    if (parentWindow && event.source !== parentWindow) return;

    switch (type) {
      case 'CAPTURE_FRAME':
        requestFrame(typeof data.requestId === 'string' ? data.requestId : '');
        break;
      case 'CAPTURE_GIF':
        requestGif(typeof data.requestId === 'string' ? data.requestId : '');
        break;
    }
  }

  window.addEventListener('message', handleMessage);
  window.addEventListener('pagehide', stopSampling);

  const existing = (window as unknown as Record<string, unknown>).__FLAXIA_CAPTURE__;
  if (!existing) {
    (window as unknown as Record<string, unknown>).__FLAXIA_CAPTURE__ = {
      findCanvas: () => findGameCanvas(),
    };
  }
}

run();
