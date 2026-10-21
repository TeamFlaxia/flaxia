import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('client content protection does not overwrite canvas APIs or expose global taint hooks', () => {
  const source = readFileSync(new URL('../src/lib/content-protection.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /HTMLCanvasElement\.prototype\.(?:toDataURL|toBlob)\s*=/);
  assert.doesNotMatch(source, /__markCanvasTainted/);
  assert.match(source, /export function initContentProtection/);
});
