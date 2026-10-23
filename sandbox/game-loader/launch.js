/** A cache miss/error/timeout must not wait for archive download or persistence. */
export async function launchWithFallback({ probe, playCached, playWvfs, warm, schedule, timeoutMs = 150 }) {
  let timer;
  let cached;
  let reason = 'miss';
  try {
    cached = await Promise.race([
      Promise.resolve().then(probe),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          reason = 'timeout';
          resolve(null);
        }, timeoutMs);
      }),
    ]);
    if (cached) {
      await playCached(cached);
      return { mode: 'cache', background: Promise.resolve() };
    }
  } catch {
    reason = 'loader-error';
  } finally {
    clearTimeout(timer);
  }
  await playWvfs();
  // schedule() runs only after WVFS is displayed. Cache failures are isolated.
  const background = Promise.resolve()
    .then(() => schedule(warm))
    .catch(() => {});
  return { mode: 'wvfs', reason, background };
}
