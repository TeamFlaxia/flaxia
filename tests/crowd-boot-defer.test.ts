// Booting the shell must not synchronously start the Crowd node: the pinned
// vendor bundle performs a blocking, multi-gigabyte WebAssembly.Memory probe
// on the main thread (vendor/flaxia-node-0.11.1.tgz memoryProbe.js).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initCrowdNode } from '../src/lib/crowd-node.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** Extract a function body by matching braces outside strings and comments. */
function functionBody(source: string, signature: RegExp): string {
  const match = signature.exec(source);
  assert.ok(match, `missing function matching ${signature}`);
  const open = source.indexOf('{', match.index);
  assert.notEqual(open, -1, 'function has no body');
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return source.slice(open, i + 1);
    }
  }
  assert.fail('unbalanced braces');
}

const bootstrapSignature = /export function initShellBootstrap\(\)/;

test('shell bootstrap does not call initCrowdNode on the critical path', async () => {
  const source = await read('src/lib/svelte/bootstrap.ts');
  const body = functionBody(source, bootstrapSignature);
  assert.match(body, /canRunFlaxiaNode\(\)/, 'the device gate must be preserved');
  assert.doesNotMatch(body, /initCrowdNode\s*\(/, 'the blocking node probe must not run during shell boot');
});

test('shell bootstrap defers Crowd init and cancels the losing scheduler', async () => {
  const source = await read('src/lib/svelte/bootstrap.ts');
  const body = functionBody(source, bootstrapSignature);
  assert.match(body, /deferCrowdNodeInit\(/, 'boot must hand init to a deferral helper');

  const deferred = functionBody(source, /function deferCrowdNodeInit\(/);
  assert.match(deferred, /requestIdleCallback\s*\(/, 'prefer an idle callback');
  assert.match(deferred, /timeout:\s*3000/, 'cap the idle wait');
  assert.match(deferred, /setTimeout\s*\(/, 'fall back to a timer');
  assert.match(deferred, /cancelIdleCallback\s*\(/, 'cancel a stale idle callback');
  assert.match(deferred, /clearTimeout\s*\(/, 'cancel the stale timer');

  // The deferred callback keeps the consent UI and error handling intact.
  const start = functionBody(source, /function startCrowdNode\(/);
  assert.match(start, /initCrowdNode\(/);
  assert.match(start, /showCrowdConsentModal\(/);
  assert.match(start, /notifyCrowdConsentChanged\(\)/);
  assert.match(start, /Failed to initialize Crowd node/);
});

test('crowd-node still exposes a callable init trigger with its full init sequence', async () => {
  assert.equal(typeof initCrowdNode, 'function');
  const source = await read('src/lib/crowd-node.ts');
  const body = functionBody(source, /export async function initCrowdNode\(/);
  assert.match(body, /await loadCrowdNodeModule\(\)/);
  assert.match(body, /initFlaxiaNode\(/);
  assert.match(body, /buildNodeConfig\(/);
  assert.match(body, /getConsentState/);
});
