// The Pages side of Mail must use the published contract, not a local copy.
//
// The Worker, the SPA and the Pages proxy all import `@flaxia/mail-contract`.
// These assertions keep the app from reintroducing a second reserved-local list
// or a local HMAC implementation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isReservedLocal, primaryAddressForUsername } from '../shared/mail-address.ts';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('mail contract wiring', () => {
  it('keeps the Pages proxy on the shared contract', () => {
    const route = source('../functions/api/routes/mail.ts');
    assert.match(route, /from '@flaxia\/mail-contract'/, 'the mail proxy must import the contract');
    assert.ok(!route.includes('const RESERVED_LOCALS = new Set'), 'the proxy must not duplicate the list');
    assert.ok(!/function hmac\s*\(/.test(route), 'the proxy must not implement its own HMAC');
  });

  it('keeps the app-local shims thin', () => {
    for (const path of ['../shared/mail-address.ts', '../shared/webcrypto.ts', '../src/lib/mail/crypto.ts']) {
      const shim = source(path);
      assert.match(shim, /@flaxia\/mail-contract/, `${path} must delegate to the contract`);
      assert.ok(!shim.includes('function hmacHex'), `${path} must not carry an implementation`);
    }
  });

  it('still enforces the reserved-local grammar', () => {
    assert.equal(isReservedLocal('postmaster'), true);
    assert.throws(() => primaryAddressForUsername('admin'), /mail_reserved/);
  });
});
