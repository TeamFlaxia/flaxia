import type { FFmpeg } from '@ffmpeg/ffmpeg';

const CORE_BASE = '/ffmpeg';

let instance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let running = false;

async function importFFmpeg(): Promise<typeof import('@ffmpeg/ffmpeg').FFmpeg> {
  const mod = await import('@ffmpeg/ffmpeg');
  return mod.FFmpeg;
}

/**
 * Lazily loads the self-hosted ffmpeg.wasm core (dist/ffmpeg). The core is
 * single-threaded on purpose: the multithreaded build would force COOP/COEP
 * headers site-wide, which would break third-party iframes and images.
 */
export async function getFFmpeg(): Promise<FFmpeg> {
  if (instance?.loaded) return instance;
  if (!loadPromise) {
    loadPromise = (async () => {
      const FFmpegClass = await importFFmpeg();
      const ffmpeg = new FFmpegClass();
      await ffmpeg.load({
        coreURL: `${CORE_BASE}/ffmpeg-core.js`,
        wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`,
      });
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
    const ffmpeg = await getFFmpeg();
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
