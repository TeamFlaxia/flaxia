import type { FFmpeg } from '@ffmpeg/ffmpeg';

// Loaded from a CDN: Pages rejects files >25MiB and the core wasm is ~31MiB,
// so the cores cannot ship inside dist/. The multithreaded core needs
// SharedArrayBuffer (cross-origin isolation), so it only loads inside the
// export popup — COOP/COEP on /export-popup.html, never site-wide (site-wide
// isolation would break third-party iframes and images).
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const CORE_MT_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm';

let instance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let running = false;

async function importFFmpeg(): Promise<typeof import('@ffmpeg/ffmpeg').FFmpeg> {
  const mod = await import('@ffmpeg/ffmpeg');
  return mod.FFmpeg;
}

export interface FFmpegLoadOptions {
  /** Load the multithreaded core (requires crossOriginIsolated). */
  multithreaded?: boolean;
}

/**
 * Lazily loads the ffmpeg.wasm core from jsDelivr (ESM build — the worker
 * imports it as a module). With `multithreaded`, loads @ffmpeg/core-mt plus
 * the same-origin pthread bootstrap from /ffmpeg/ (Workers cannot be created
 * from cross-origin URLs).
 */
export async function getFFmpeg(options: FFmpegLoadOptions = {}): Promise<FFmpeg> {
  if (instance?.loaded) return instance;
  if (!loadPromise) {
    const multithreaded = options.multithreaded === true;
    loadPromise = (async () => {
      const FFmpegClass = await importFFmpeg();
      const ffmpeg = new FFmpegClass();
      await ffmpeg.load(
        multithreaded
          ? {
              coreURL: `${CORE_MT_BASE}/ffmpeg-core.js`,
              wasmURL: `${CORE_MT_BASE}/ffmpeg-core.wasm`,
              workerURL: `${window.location.origin}/ffmpeg/ffmpeg-core.worker.js`,
            }
          : {
              coreURL: `${CORE_BASE}/ffmpeg-core.js`,
              wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`,
            },
      );
      instance = ffmpeg;
      return ffmpeg;
    })();
  }
  try {
    return await loadPromise;
  } catch (error) {
    loadPromise = null;
    instance = null;
    throw error;
  }
}

export interface FFmpegRunOptions {
  inputs: Array<{ name: string; data: Uint8Array }>;
  args: string[];
  outputName: string;
  onProgress?: (ratio: number) => void;
  /** Returns true when the user aborted the render — checked before load/exec. */
  signal?: () => boolean;
  /** Load the multithreaded core (requires crossOriginIsolated). */
  multithreaded?: boolean;
}

/**
 * Runs a single ffmpeg job: writes inputs to the MEM FS, executes, reads the
 * output and cleans up. Concurrent runs are rejected — the editor modal
 * serializes work anyway, and a shared MEM FS makes overlap unsafe.
 */
export async function runFFmpeg(options: FFmpegRunOptions): Promise<Uint8Array> {
  if (running) {
    throw new Error('ffmpeg busy');
  }
  running = true;
  try {
    if (options.signal?.()) throw new Error('render cancelled');
    const ffmpeg = await getFFmpeg({ multithreaded: options.multithreaded });
    const written: string[] = [];
    let progressCallback: ((data: { progress: number }) => void) | null = null;
    try {
      for (const input of options.inputs) {
        await ffmpeg.writeFile(input.name, input.data);
        written.push(input.name);
      }
      if (options.signal?.()) throw new Error('render cancelled');

      if (options.onProgress) {
        const cb = (data: { progress: number }) => {
          const ratio = Number.isFinite(data.progress) ? Math.min(Math.max(data.progress, 0), 1) : 0;
          options.onProgress?.(ratio);
        };
        progressCallback = cb;
        ffmpeg.on('progress', cb);
      }

      const exitCode = await ffmpeg.exec(options.args);
      if (exitCode !== 0) {
        throw new Error(`ffmpeg exited with code ${exitCode}`);
      }

      const output = await ffmpeg.readFile(options.outputName);
      if (typeof output === 'string') {
        throw new Error('ffmpeg produced no binary output');
      }
      return output as Uint8Array;
    } finally {
      if (progressCallback) {
        ffmpeg.off('progress', progressCallback);
      }
      for (const name of [...written, options.outputName]) {
        try {
          await ffmpeg.deleteFile(name);
        } catch {
          /* file may not exist */
        }
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Forcefully kills the ffmpeg worker (used when the user cancels a render).
 * The next getFFmpeg() call reloads a fresh instance.
 */
export function terminateFFmpeg(): void {
  if (instance) {
    try {
      instance.terminate();
    } catch {
      /* already dead */
    }
  }
  instance = null;
  loadPromise = null;
  running = false;
}

export function isFFmpegLoaded(): boolean {
  return instance?.loaded === true;
}
