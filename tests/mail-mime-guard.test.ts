// Header injection + quota validation (docs/mail.md §9.2, §11.2).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertNoHeaderInjection,
  DEFAULT_DAILY_EXTERNAL_SENDS,
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_OUTBOUND_BYTES,
  MAX_RECIPIENTS,
  validateOutboundRecipients,
  validateOutboundSize,
} from '../mail-worker/src/send.ts';

describe('mail MIME send guards', () => {
  it('rejects CR/LF in header-bearing fields', () => {
    assert.throws(() => assertNoHeaderInjection('a@flaxia.app\r\nBcc: victim@evil.com', 'to'), /mail_header_injection/);
    assert.throws(() => assertNoHeaderInjection('subject\nX-Evil: 1', 'subject'), /mail_header_injection/);
    assert.doesNotThrow(() => assertNoHeaderInjection('Alice <alice@flaxia.app>', 'to'));
  });

  it('caps recipients and size', () => {
    assert.throws(() => validateOutboundRecipients([]), /mail_no_recipients/);
    assert.throws(
      () => validateOutboundRecipients(Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@flaxia.app`)),
      /mail_too_many_recipients/,
    );
    assert.throws(() => validateOutboundSize(MAX_OUTBOUND_BYTES + 1), /mail_too_large/);
    assert.doesNotThrow(() => validateOutboundSize(MAX_OUTBOUND_BYTES));
  });

  it('normalizes recipients and exposes 512 MiB quota', () => {
    assert.deepEqual(validateOutboundRecipients(['  Alice@Flaxia.App ']), ['alice@flaxia.app']);
    assert.equal(DEFAULT_STORAGE_QUOTA_BYTES, 512 * 1024 * 1024);
    assert.equal(DEFAULT_DAILY_EXTERNAL_SENDS, 20);
  });
});
