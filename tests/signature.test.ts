import assert from 'node:assert';
import { describe, it } from 'node:test';
import { verifyHttpSignature } from '../functions/lib/activitypub/signature.ts';

describe('HTTP Signature Verification', () => {
  it('should reject requests without a Signature header', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'POST',
      headers: {
        Date: new Date().toUTCString(),
        Digest: 'SHA-256=abc',
      },
    });
    const result = await verifyHttpSignature(request, 'public-key-pem');
    assert.strictEqual(result, false);
  });

  it('should reject requests with empty Signature header', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'POST',
      headers: {
        Signature: '',
        Date: new Date().toUTCString(),
      },
    });
    const result = await verifyHttpSignature(request, 'public-key-pem');
    assert.strictEqual(result, false);
  });

  it('should reject requests with malformed Signature header', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'POST',
      headers: {
        Signature: 'not-a-valid-signature-format',
        Date: new Date().toUTCString(),
      },
    });
    const result = await verifyHttpSignature(request, 'public-key-pem');
    assert.strictEqual(result, false);
  });

  it('should reject requests with Signature missing required keyId', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'POST',
      headers: {
        Signature: 'headers="(request-target) host date",signature="abc123"',
        Date: new Date().toUTCString(),
      },
    });
    const result = await verifyHttpSignature(request, 'public-key-pem');
    assert.strictEqual(result, false);
  });

  it('should reject requests with Signature missing signature parameter', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'POST',
      headers: {
        Signature: 'keyId="https://example.com#key",headers="(request-target) host date"',
        Date: new Date().toUTCString(),
      },
    });
    const result = await verifyHttpSignature(request, 'public-key-pem');
    assert.strictEqual(result, false);
  });

  it('should reject requests with empty public key', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'POST',
      headers: {
        Signature: 'keyId="https://example.com#key",headers="(request-target) host date",signature="abc123"',
        Date: new Date().toUTCString(),
      },
    });
    const result = await verifyHttpSignature(request, '');
    assert.strictEqual(result, false);
  });

  it('should handle requests without Date header', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'POST',
      headers: {
        Signature: 'keyId="https://example.com#key",headers="(request-target) host",signature="abc123"',
      },
    });
    const result = await verifyHttpSignature(request, 'public-key-pem');
    assert.strictEqual(result, false);
  });

  it('should reject requests with invalid Digest header', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'POST',
      headers: {
        Signature: 'keyId="https://example.com#key",headers="(request-target) host date digest",signature="abc123"',
        Date: new Date().toUTCString(),
        Digest: '',
      },
    });
    const result = await verifyHttpSignature(request, 'public-key-pem');
    assert.strictEqual(result, false);
  });

  it('should reject requests with GET method on inbox', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'GET',
      headers: {
        Signature: 'keyId="https://example.com#key",headers="(request-target) host date",signature="abc123"',
        Date: new Date().toUTCString(),
      },
    });
    const result = await verifyHttpSignature(request, 'public-key-pem');
    assert.strictEqual(result, false);
  });
});
