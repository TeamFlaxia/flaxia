import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realProfileEmail, safeReturnPath } from '../functions/lib/auth-redirect.ts';

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

test('only real profile emails are copied to Auth', () => {
  assert.equal(realProfileEmail('User@Example.com'), 'user@example.com');
  assert.equal(realProfileEmail('  a@b.co  '), 'a@b.co');
  for (const value of ['x@users.flaxia.invalid', 'not-an-email', '', null, undefined]) {
    assert.equal(realProfileEmail(value), null, String(value));
  }
});
