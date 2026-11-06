import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  isReservedLocal,
  isValidMailAddress,
  normalizeMailAddress,
  primaryAddressForUsername,
  RESERVED_LOCALS,
} from '../src/lib/mail/address.ts';

describe('mail addresses', () => {
  it('builds lowercase primary addresses from usernames', () => {
    assert.equal(primaryAddressForUsername('Alice_1'), 'alice_1@flaxia.app');
    assert.equal(primaryAddressForUsername('  Bob  '), 'bob@flaxia.app');
  });

  it('normalizes case and whitespace', () => {
    assert.equal(normalizeMailAddress('  Alice@FLAXIA.APP '), 'alice@flaxia.app');
  });

  it('rejects reserved locals', () => {
    for (const reserved of [
      'admin',
      'abuse',
      'billing',
      'dmarc',
      'hostmaster',
      'mailerdaemon',
      'noreply',
      'postmaster',
      'root',
      'security',
      'support',
      'team',
      'webmaster',
    ]) {
      assert.equal(isReservedLocal(reserved), true);
      assert.throws(() => primaryAddressForUsername(reserved), /mail_reserved/);
    }
  });

  it('keeps the Pages proxy and Mail Worker on the shared reserved list', () => {
    for (const path of ['../functions/api/routes/mail.ts', '../mail-worker/src/index.ts']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      assert.match(source, /src\/lib\/mail\/address\.ts/, `${path} must import the shared address module`);
      assert.ok(!source.includes('const RESERVED_LOCALS = new Set'), `${path} must not duplicate the list`);
    }
    assert.ok(RESERVED_LOCALS.size >= 20, 'operational lookalikes must stay reserved');
  });

  it('rejects invalid usernames', () => {
    assert.throws(() => primaryAddressForUsername('bad name!'), /mail_invalid_username/);
    assert.throws(() => primaryAddressForUsername(''), /mail_invalid_username/);
    assert.throws(() => primaryAddressForUsername('a'.repeat(21)), /mail_invalid_username/);
  });

  it('validates mail addresses', () => {
    assert.equal(isValidMailAddress('alice@flaxia.app'), true);
    assert.equal(isValidMailAddress('alice@mail.flaxia.app'), true);
    assert.equal(isValidMailAddress('alice@example.com'), false);
    assert.equal(isValidMailAddress('no-at-sign'), false);
  });
});
