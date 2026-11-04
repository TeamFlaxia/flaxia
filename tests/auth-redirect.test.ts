import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeReturnPath } from '../functions/lib/auth-redirect.ts';

test('post-login returns stay on the application origin', () => {
  assert.equal(safeReturnPath('/home'), '/home');
  assert.equal(safeReturnPath('/settings?tab=account'), '/settings?tab=account');
  assert.equal(safeReturnPath('/thread/abc'), '/thread/abc');
  for (const value of [
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example',
    '/\r\nSet-Cookie: x=y',
    '/'.padEnd(600, 'a'),
    null,
    '',
  ]) {
    assert.equal(safeReturnPath(value), '/home', String(value));
  }
});
