import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CROWD_NODE_VERSION, crowdNodeEntry } from '../src/lib/crowd-node.ts';

test('desktop Crowd imports resolve to bundled modules on every native origin', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else delete (globalThis as { window?: unknown }).window;
  });
  for (const href of [
    'tauri://localhost/index.html',
    'http://tauri.localhost/index.html',
    'https://tauri.localhost/index.html',
  ]) {
    const location = new URL(href);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, __TAURI_INTERNALS__: {} } });
    const entry = new URL(crowdNodeEntry(), location);
    assert.equal(entry.pathname, `/native-crowd/v${CROWD_NODE_VERSION}-0/index.js`);
    assert.equal(new URL('./worker.js', entry).pathname, `/native-crowd/v${CROWD_NODE_VERSION}-0/worker.js`);
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: new URL('https://flaxia.app/') },
  });
  assert.equal(crowdNodeEntry(), `/api/crowd/v${CROWD_NODE_VERSION}-0/index.js`);
});

test('desktop build copies the pinned module graph and worker assets and rejects version drift', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'flaxia-native-crowd-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'node_modules/@flaxia/node');
  mkdirSync(join(source, 'dist/assets'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: CROWD_NODE_VERSION }));
  const modules = {
    'index.js': 'import "./assets/dist.js"; export const worker = new URL("./worker.js", import.meta.url);',
    'worker.js': 'import "./assets/dist.js"; import("./assets/inference.js");',
    'assets/dist.js': 'export const ready = true;',
    'assets/inference.js': 'export const infer = () => 42;',
  };
  for (const [path, body] of Object.entries(modules)) writeFileSync(join(source, 'dist', path), body);
  writeFileSync(join(source, 'dist/index.d.ts'), 'export declare const worker: URL;');
  const script = fileURLToPath(new URL('../scripts/build-native-crowd.mjs', import.meta.url));
  execFileSync(process.execPath, [script], { cwd: root });
  const destination = join(root, 'dist/native-crowd', `v${CROWD_NODE_VERSION}-0`);
  for (const [path, body] of Object.entries(modules)) assert.equal(readFileSync(join(destination, path), 'utf8'), body);
  assert.throws(() => readFileSync(join(destination, 'index.d.ts')));
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  assert.throws(() => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' }), /must match/);
  const repo = dirname(dirname(script));
  const base = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.conf.base.json'), 'utf8'));
  assert.equal(base.build.beforeBuildCommand, 'npm run build:desktop');
});
