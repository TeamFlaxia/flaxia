// `npm run dev -- --hot` rebuilds with `vite build --watch`, which regenerates
// _worker.js and drops the postbuild platform injection. The watcher must
// recognise an unpatched worker so it can rerun postbuild.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerNeedsPlatformPatch } from '../scripts/dev-worker-watch.mjs';

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
