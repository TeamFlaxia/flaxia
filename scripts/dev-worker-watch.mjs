// `vite build --watch` regenerates adapter-cloudflare's _worker.js from its
// template, dropping the platform env/context injection that postbuild.mjs
// applies. Watch the generated file and re-run postbuild whenever the marker
// disappears. The marker check prevents a rebuild loop caused by postbuild's
// own write of _worker.js.

import { unwatchFile, watchFile } from 'node:fs';
import { readFile as readText } from 'node:fs/promises';

// Shared with scripts/postbuild.mjs so the patcher and the watcher agree on
// what "already patched" means. Both must use this exact marker.
export const WORKER_PATCH_MARKER = '__als.run({ env, ctx }';

/** True when the generated worker still needs (or has lost) the platform patch. */
export function workerNeedsPlatformPatch(source) {
  return typeof source !== 'string' || !source.includes(WORKER_PATCH_MARKER);
}

/**
 * Pure decision helper used by the watcher. A patch is applied only when there
 * is a watched file, it changed, no other patch is running and the marker is
 * still missing. Keeping this pure makes the watcher's gating testable.
 */
export function shouldApplyPatch(workerFile, needsPatch, { changed = true, busy = false } = {}) {
  return typeof workerFile === 'string' && workerFile.length > 0 && changed && !busy && needsPatch === true;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Watch `workerFile` and call `onRebuild()` whenever an unpatched worker appears.
 * Checks once at registration (the file may already be stale) and rechecks after
 * a busy patch clears so a rebuild arriving during one is never dropped.
 * Returns an unwatch function; it is also called automatically on process exit.
 */
export function watchWorkerPatch(workerFile, onRebuild, { interval = 1000, debounceMs = 400 } = {}) {
  let busy = false;
  let pending = false;
  let stopped = false;

  const applyIfNeeded = async ({ changed = true } = {}) => {
    if (stopped) return;
    if (busy) {
      // Remember the event; the finally block re-evaluates it after the patch.
      pending = true;
      return;
    }
    busy = true;
    try {
      // Let Vite finish writing the whole output directory before patching.
      await delay(debounceMs);
      let source;
      try {
        source = await readText(workerFile, 'utf8');
      } catch {
        return; // file temporarily absent during rebuild
      }
      if (!shouldApplyPatch(workerFile, workerNeedsPlatformPatch(source), { changed })) return;
      console.log('[dev] Re-applying the platform patch after a hot rebuild…');
      await onRebuild();
    } catch (error) {
      console.error('[dev] Failed to re-apply the worker patch:', error);
    } finally {
      busy = false;
      if (pending && !stopped) {
        pending = false;
        void applyIfNeeded();
      }
    }
  };

  const listener = async (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs) return;
    await applyIfNeeded();
  };

  watchFile(workerFile, { interval }, listener);
  void applyIfNeeded();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    unwatchFile(workerFile, listener);
    process.off('exit', stop);
  };
  process.once('exit', stop);
  return stop;
}
