// `vite build --watch` regenerates adapter-cloudflare's _worker.js from its
// template, dropping the platform env/context injection that postbuild.mjs
// applies. Watch the generated file and re-run postbuild whenever the marker
// disappears. The marker check prevents a rebuild loop caused by postbuild's
// own write of _worker.js.

import { unwatchFile, watchFile } from 'node:fs';
import { readFile as readText } from 'node:fs/promises';

const PATCH_MARKER = '__als.run({ env, ctx }';

/** True when the generated worker still needs (or has lost) the platform patch. */
export function workerNeedsPlatformPatch(source) {
  return typeof source !== 'string' || !source.includes(PATCH_MARKER);
}

/**
 * Watch `workerFile` and call `onRebuild()` whenever an unpatched worker appears.
 * Returns an unwatch function.
 */
export function watchWorkerPatch(workerFile, onRebuild, { interval = 1000, debounceMs = 400 } = {}) {
  let busy = false;
  const listener = async (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs || busy) return;
    busy = true;
    try {
      // Let Vite finish writing the whole output directory before patching.
      await new Promise((resolve) => setTimeout(resolve, debounceMs));
      let source;
      try {
        source = await readText(workerFile, 'utf8');
      } catch {
        return; // file temporarily absent during rebuild
      }
      if (!workerNeedsPlatformPatch(source)) return;
      console.log('[dev] Re-applying the platform patch after a hot rebuild…');
      await onRebuild();
    } catch (error) {
      console.error('[dev] Failed to re-apply the worker patch:', error);
    } finally {
      busy = false;
    }
  };
  watchFile(workerFile, { interval }, listener);
  return () => unwatchFile(workerFile, listener);
}
