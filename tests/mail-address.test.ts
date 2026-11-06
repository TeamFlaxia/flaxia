import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isReservedLocal,
  isValidMailAddress,
  normalizeMailAddress,
  primaryAddressForUsername,
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
    for (const reserved of ['admin', 'abuse', 'dmarc', 'noreply', 'postmaster', 'security', 'support', 'team']) {
      assert.equal(isReservedLocal(reserved), true);
      assert.throws(() => primaryAddressForUsername(reserved), /mail_reserved/);
    }
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
