import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { SandboxMessage } from './bridge.js';

const CAPTURE_TIMEOUT = 10000;

export interface CapturedFrame {
  width: number;
  height: number;
  ts: number;
  data: Uint8ClampedArray;
}

export interface ScoreCardMeta {
  title: string;
  username: string;
  score?: number;
  footer?: string;
}

export interface ArcadeCaptureClientOptions {
  iframe: HTMLIFrameElement;
  targetOrigin: string;
  onReady?: (ok: boolean) => void;
  onError?: (message: string) => void;
  onPostScore?: (score: number, label: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: number;
}

export class ArcadeCaptureClient {
  private iframe: HTMLIFrameElement;
  private targetOrigin: string;
  private onReady?: (ok: boolean) => void;
  private onError?: (message: string) => void;
  private onPostScore?: (score: number, label: string) => void;
  private messageHandler: (event: MessageEvent) => void;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private ready = false;
  private destroyed = false;

  constructor(options: ArcadeCaptureClientOptions) {
    this.iframe = options.iframe;
    // Sandboxed ZIP frames have an opaque origin ("null"), so a specific
    // target origin causes postMessage to throw. The exact contentWindow is
    // still checked on every response in handleMessage.
    this.targetOrigin = options.iframe.sandbox.contains('allow-same-origin') ? options.targetOrigin : '*';
    this.onReady = options.onReady;
    this.onError = options.onError;
    this.onPostScore = options.onPostScore;
    this.messageHandler = this.handleMessage.bind(this);
    window.addEventListener('message', this.messageHandler);
  }

  init(): void {
    if (this.destroyed) return;
    // Handshake: ask the bridge to locate the canvas and start the rolling buffer.
    this.send({ type: 'CAPTURE_INIT' });
  }

  requestFrame(timeoutMs: number = CAPTURE_TIMEOUT): Promise<Blob> {
    return this.request<ArrayBuffer>('CAPTURE_FRAME', timeoutMs).then(
      (data) => new Blob([data], { type: 'image/png' }),
    );
  }

  requestGif(timeoutMs: number = CAPTURE_TIMEOUT): Promise<CapturedFrame[]> {
    return this.request<CapturedFrame[]>('CAPTURE_GIF', timeoutMs).then((frames) =>
      frames.map((frame) => ({
        width: frame.width,
        height: frame.height,
        ts: frame.ts,
        data: new Uint8ClampedArray(frame.data),
      })),
    );
  }

  encodeGif(frames: CapturedFrame[], delayMs: number = 150): Blob {
    if (frames.length === 0) throw new Error('no-frames');
    const gif = GIFEncoder();
    gif.writeHeader();
    for (const frame of frames) {
      const palette = quantize(frame.data, 256);
      const index = applyPalette(frame.data, palette);
      gif.writeFrame(index, frame.width, frame.height, {
        palette,
        delay: Math.max(1, Math.round(delayMs / 10)),
        repeat: 0,
      });
    }
    gif.finish();
    const out = new Uint8Array(gif.bytes());
    return new Blob([out.buffer], { type: 'image/gif' });
  }

  composeScoreCard(screenshot: Blob, meta: ScoreCardMeta): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          resolve(this.drawScoreCard(img, meta));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      img.onerror = () => reject(new Error('screenshot-decode-failed'));
      img.src = URL.createObjectURL(screenshot);
    });
  }

  private drawScoreCard(img: HTMLImageElement, meta: ScoreCardMeta): Blob {
    const pad = 24;
    const scale = 1080 / img.naturalWidth;
    const photoWidth = 1080;
    const photoHeight = Math.round(img.naturalHeight * scale);
    const headerH = 120;
    const footerH = 96;
    const width = photoWidth + pad * 2;
    const height = headerH + photoHeight + footerH + pad * 2;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas-context-failed');

    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, width, height);

    // Header
    ctx.fillStyle = '#141a21';
    ctx.fillRect(0, 0, width, headerH + pad);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText(this.clipText(ctx, meta.title, width - 80, 36), 40, (headerH + pad) / 2);

    // Photo (bilinear/bicubic resampling so upscaling stays smooth)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, pad, headerH + pad, photoWidth, photoHeight);

    // Footer
    const footerY = headerH + pad + photoHeight;
    ctx.fillStyle = '#141a21';
    ctx.fillRect(0, footerY, width, footerH + pad);

    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`@${meta.username}`, 40, footerY + (footerH + pad) / 2);

    if (meta.score !== undefined && !Number.isNaN(meta.score)) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 52px sans-serif';
      ctx.fillText(meta.score.toLocaleString(), width - 40, footerY + (footerH + pad) / 2);
    }

    if (meta.footer) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '22px sans-serif';
      ctx.fillText(meta.footer, width - 40, headerH + pad / 2);
    }

    const dataUrl = canvas.toDataURL('image/png');
    return dataUrlToBlob(dataUrl);
  }

  private clipText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, fontSize: number): string {
    ctx.font = `bold ${fontSize}px sans-serif`;
    const ellipsis = '…';
    if (ctx.measureText(text).width <= maxWidth) return text;
    let clipped = text;
    while (clipped.length > 1 && ctx.measureText(clipped + ellipsis).width > maxWidth) {
      clipped = clipped.slice(0, -1);
    }
    return clipped + ellipsis;
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('message', this.messageHandler);
    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('capture-aborted'));
    });
    this.pending.clear();
  }

  private request<T>(type: 'CAPTURE_FRAME' | 'CAPTURE_GIF', timeoutMs: number = CAPTURE_TIMEOUT): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error('capture-destroyed'));
    const requestId = `cap_${++this.requestCounter}_${Date.now()}`;

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('capture-timeout'));
      }, timeoutMs);

      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });

      if (type === 'CAPTURE_FRAME') {
        this.send({ type: 'CAPTURE_FRAME', requestId });
      } else {
        this.send({ type: 'CAPTURE_GIF', requestId });
      }
    });
  }

  private handleMessage(event: MessageEvent): void {
    // Source check is the reliable guard for opaque-origin iframes.
    if (event.source !== this.iframe.contentWindow) return;

    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // Learn the sandbox's real origin from the first message we receive.
    // The WVFS iframe 301-redirects to the sandbox worker, so the compile-time
    // origin may not match the iframe's actual origin after navigation.
    if (event.origin && event.origin !== 'null' && this.targetOrigin !== event.origin) {
      this.targetOrigin = event.origin;
    }

    switch (data.type) {
      case 'POST_SCORE': {
        if (typeof data.score === 'number' && !Number.isNaN(data.score) && typeof data.label === 'string') {
          this.onPostScore?.(data.score, data.label);
        }
        break;
      }
      case 'CAPTURE_READY': {
        this.ready = data.ok === true;
        if (!this.ready) this.onError?.('no-canvas');
        this.onReady?.(this.ready);
        break;
      }
      case 'CAPTURE_FRAME_RESULT': {
        const pending = this.pending.get(data.requestId);
        if (!pending) break;
        this.pending.delete(data.requestId);
        window.clearTimeout(pending.timer);
        if (data.data instanceof ArrayBuffer) {
          pending.resolve(data.data);
        } else {
          pending.reject(new Error('capture-frame-invalid'));
        }
        break;
      }
      case 'CAPTURE_GIF_RESULT': {
        const pending = this.pending.get(data.requestId);
        if (!pending) break;
        this.pending.delete(data.requestId);
        window.clearTimeout(pending.timer);
        if (Array.isArray(data.frames)) {
          pending.resolve(data.frames);
        } else {
          pending.reject(new Error('capture-gif-invalid'));
        }
        break;
      }
      case 'CAPTURE_ERROR': {
        const pending = this.pending.get(data.requestId);
        if (!pending) break;
        this.pending.delete(data.requestId);
        window.clearTimeout(pending.timer);
        pending.reject(new Error(data.message || 'capture-error'));
        this.onError?.(data.message || 'capture-error');
        break;
      }
    }
  }

  private send(message: SandboxMessage): void {
    this.iframe.contentWindow?.postMessage(message, this.targetOrigin);
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',');
  const mimeMatch = /data:(.*?);/.exec(header);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
