import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../functions/api/sandbox/', import.meta.url);

test('retired same-origin sandbox routes must not create service workers', () => {
  const source = readFileSync(new URL('[[route]].ts', root), 'utf8');
  const post = readFileSync(new URL('post/[postId].ts', root), 'utf8');
  assert.match(source, /status:\s*410/);
  assert.match(post, /status:\s*410/);
  assert.doesNotMatch(source, /importScripts|Service-Worker-Allowed|addEventListener\(['"]fetch/);
  assert.doesNotMatch(post, /serviceWorker\.register|sandbox="allow-same-origin"/);
});
