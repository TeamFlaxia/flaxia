// `npm run dev -- --hot` rebuilds with `vite build --watch`, which regenerates
// _worker.js and drops the postbuild platform injection. The watcher must
// recognise an unpatched worker so it can rerun postbuild.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shouldApplyPatch, watchWorkerPatch, workerNeedsPlatformPatch } from '../scripts/dev-worker-watch.mjs';

const PATCHED_WORKER = `const __als = new AsyncLocalStorage();
export default { async fetch(req, env, ctx) {
  return await __als.run({ env, ctx }, () => server.respond(req, { platform: __platform }));
} };
`;

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for the watcher');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('an adapter-generated worker needs the platform patch', () => {
  const adapterTemplate = `
    import { env } from 'cloudflare:workers';
    const initialized = server.init({ env });
    export default { async fetch(req, env) { return await server.respond(req, { getClientAddress() { return ''; } }); } };
  `;
  assert.equal(workerNeedsPlatformPatch(adapterTemplate), true);
});

test('a postbuild-patched worker is left alone (no rebuild loop)', () => {
  const patched = `
    const __als = new AsyncLocalStorage();
    const __platform = { get env() { return __als.getStore()?.env; } };
    export default { async fetch(req, env, ctx) {
      return await __als.run({ env, ctx }, () => server.respond(req, { platform: __platform }));
    } };
  `;
  assert.equal(workerNeedsPlatformPatch(patched), false);
});

test('an empty or missing worker does not look patched', () => {
  assert.equal(workerNeedsPlatformPatch(''), true);
});

test('shouldApplyPatch gates on the file, the pending state and the marker', () => {
  const workerFile = '/tmp/flaxia-out/_worker.js';
  assert.equal(shouldApplyPatch(workerFile, true), true, 'a stale watched worker must be patched');
  assert.equal(shouldApplyPatch(workerFile, false), false, 'a patched worker must not be rewritten');
  assert.equal(shouldApplyPatch('', true), false, 'no watched file means nothing to patch');
  assert.equal(shouldApplyPatch(workerFile, true, { busy: true }), false, 'do not run two patches at once');
  assert.equal(shouldApplyPatch(workerFile, true, { changed: false }), false, 'an unchanged file needs no patch');
});

test('watchWorkerPatch checks the worker when registration happens', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flaxia-worker-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workerFile = join(dir, '_worker.js');
  writeFileSync(workerFile, 'export default { async fetch(req, env) {} };\n');
  let calls = 0;
  const stop = watchWorkerPatch(
    workerFile,
    async () => {
      calls += 1;
      writeFileSync(workerFile, PATCHED_WORKER);
    },
    { interval: 20, debounceMs: 0 },
  );
  t.after(stop);

  await waitFor(() => calls === 1);
  assert.equal(workerNeedsPlatformPatch(readFileSync(workerFile, 'utf8')), false);
  assert.equal(calls, 1, 'the watcher must not loop on its own patch');
});

test('watchWorkerPatch rechecks after a rebuild arrives while busy', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flaxia-worker-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workerFile = join(dir, '_worker.js');
  const stale = 'export default { async fetch(req, env) {} };\n';
  writeFileSync(workerFile, stale);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const stop = watchWorkerPatch(
    workerFile,
    async () => {
      calls += 1;
      if (calls === 1) await gate;
      else writeFileSync(workerFile, PATCHED_WORKER);
    },
    { interval: 20, debounceMs: 0 },
  );
  t.after(stop);

  await waitFor(() => calls === 1);
  // Simulate Vite rewriting the worker while the first patch is blocked.
  writeFileSync(workerFile, stale);
  await new Promise((resolve) => setTimeout(resolve, 120));
  release();
  await waitFor(() => calls === 2);
  assert.equal(calls, 2, 'the rebuild seen during a busy patch must not be dropped');
  assert.equal(workerNeedsPlatformPatch(readFileSync(workerFile, 'utf8')), false);
});
