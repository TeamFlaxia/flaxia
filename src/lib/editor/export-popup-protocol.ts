import type { ExportJob } from './export-job.ts';

/**
 * Main page ↔ export popup protocol.
 *
 * The popup document is cross-origin isolated (COOP/COEP on
 * /export-popup.html only) so it can load the multithreaded ffmpeg core,
 * which needs SharedArrayBuffer. COOP severs window.opener, so every message
 * travels over a BroadcastChannel; the popup WindowProxy is used only as a
 * best-effort second path for main→popup messages (jobs are deduplicated by
 * id on the popup side) and for close()/closed checks.
 */
export const EXPORT_CHANNEL_NAME = 'flaxia-export';
/** Reject reason when the popup never picks the job up — caller falls back inline. */
export const EXPORT_UNREACHABLE = 'export-unreachable';

const POPUP_URL = '/export-popup.html';
const POPUP_NAME = 'flaxia-export';
/** Job handoff budget: `accepted` is posted before the core starts loading. */
const ACCEPT_TIMEOUT_MS = 5000;
const OPEN_TIMEOUT_MS = 10_000;

export type MainToPopup =
  | { type: 'ping' }
  | { type: 'job'; id: string; job: ExportJob }
  | { type: 'cancel'; id: string }
  | { type: 'bye' };

export type PopupToMain =
  | { type: 'ready'; isolated: boolean }
  | { type: 'accepted'; id: string }
  | { type: 'progress'; id: string; ratio: number }
  | { type: 'result'; id: string; file: File }
  | { type: 'error'; id: string; message: string }
  | { type: 'cancelled'; id: string };

export function isExportUnreachable(error: unknown): boolean {
  return error instanceof Error && error.message === EXPORT_UNREACHABLE;
}

interface PendingRun {
  id: string;
  timer: number;
  onProgress?: (ratio: number) => void;
  onAccepted?: () => void;
  resolve: (file: File) => void;
  reject: (error: Error) => void;
}

export class ExportSession {
  static async open(timeoutMs = OPEN_TIMEOUT_MS): Promise<ExportSession | null> {
    if (typeof BroadcastChannel === 'undefined') return null;
    let popup: Window | null = null;
    try {
      popup = window.open(POPUP_URL, POPUP_NAME, 'popup=yes,width=460,height=320');
    } catch {
      return null;
    }
    if (!popup) return null;
    const session = new ExportSession(popup);
    const ok = await session.waitForReady(timeoutMs);
    if (!ok) {
      session.dispose();
      return null;
    }
    return session;
  }

  private readonly popup: Window;
  private readonly channel: BroadcastChannel;
  private readonly closePoll: number;
  private pending: PendingRun | null = null;
  private readyWait: { resolve: (ok: boolean) => void; timer: number } | null = null;
  private disposed = false;

  private constructor(popup: Window) {
    this.popup = popup;
    this.channel = new BroadcastChannel(EXPORT_CHANNEL_NAME);
    this.channel.onmessage = (event) => this.onMessage(event.data as PopupToMain);
    this.closePoll = window.setInterval(() => {
      if (!this.popup.closed) return;
      if (this.readyWait) {
        const wait = this.readyWait;
        this.readyWait = null;
        clearTimeout(wait.timer);
        wait.resolve(false);
      }
      this.rejectPending('render cancelled');
      this.dispose(false);
    }, 700);
  }

  private postToPopup(message: MainToPopup): void {
    if (this.disposed) return;
    this.channel.postMessage(message);
    try {
      this.popup.postMessage(message, window.location.origin);
    } catch {
      /* WindowProxy unusable — BroadcastChannel still delivers */
    }
  }

  private waitForReady(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.readyWait = {
        resolve,
        timer: window.setTimeout(() => {
          this.readyWait = null;
          resolve(false);
        }, timeoutMs),
      };
      this.postToPopup({ type: 'ping' });
    });
  }

  private settlePending(fn: (pending: PendingRun) => void): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    fn(pending);
  }

  private rejectPending(message: string): void {
    this.settlePending((pending) => pending.reject(new Error(message)));
  }

  private onMessage(message: PopupToMain): void {
    if (this.disposed || !message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready': {
        if (!this.readyWait) return;
        const wait = this.readyWait;
        this.readyWait = null;
        clearTimeout(wait.timer);
        wait.resolve(message.isolated);
        return;
      }
      case 'accepted':
        if (this.pending?.id !== message.id) return;
        clearTimeout(this.pending.timer);
        this.pending.onAccepted?.();
        return;
      case 'progress':
        if (this.pending?.id === message.id) this.pending.onProgress?.(message.ratio);
        return;
      case 'result': {
        if (this.pending?.id !== message.id) return;
        this.settlePending((pending) => pending.resolve(message.file));
        return;
      }
      case 'error': {
        if (this.pending?.id !== message.id) return;
        this.settlePending((pending) => pending.reject(new Error(message.message)));
        return;
      }
      case 'cancelled':
        if (this.pending?.id !== message.id) return;
        this.rejectPending('render cancelled');
        return;
    }
  }

  /**
   * Sends the job to the popup and resolves with the encoded file.
   * Rejects with EXPORT_UNREACHABLE (after disposing) when the popup never
   * acknowledges — the caller should fall back to the inline encoder.
   */
  run(job: ExportJob, options: { onProgress?: (ratio: number) => void; onAccepted?: () => void } = {}): Promise<File> {
    if (this.disposed || this.popup.closed) {
      return Promise.reject(new Error(EXPORT_UNREACHABLE));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending = {
        id,
        timer: window.setTimeout(() => {
          if (this.pending?.id !== id) return;
          this.pending = null;
          this.dispose();
          reject(new Error(EXPORT_UNREACHABLE));
        }, ACCEPT_TIMEOUT_MS),
        onProgress: options.onProgress,
        onAccepted: options.onAccepted,
        resolve,
        reject,
      };
      this.postToPopup({ type: 'job', id, job });
    });
  }

  /** Asks the popup to terminate its ffmpeg worker. Completion arrives as `cancelled`. */
  cancel(): void {
    if (!this.pending) return;
    this.postToPopup({ type: 'cancel', id: this.pending.id });
  }

  dispose(closePopup = true): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.closePoll);
    if (this.readyWait) {
      clearTimeout(this.readyWait.timer);
      const resolve = this.readyWait.resolve;
      this.readyWait = null;
      resolve(false);
    }
    this.rejectPending('render cancelled');
    try {
      this.channel.postMessage({ type: 'bye' });
    } catch {
      /* channel already failing */
    }
    this.channel.close();
    if (closePopup) {
      try {
        this.popup.close();
      } catch {
        /* COOP may block close — the popup also self-closes on bye */
      }
    }
  }
}
