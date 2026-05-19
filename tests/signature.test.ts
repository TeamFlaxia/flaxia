import { describe, it } from 'node:test'
import assert from 'node:assert'
import { verifyHttpSignature } from '../functions/lib/activitypub/signature.ts'

// Mock Request object if necessary for testing
// Since this is node:test, we can create mock objects
describe('HTTP Signature Verification', () => {
  it('should reject requests without a Signature header', async () => {
    const request = new Request('https://example.com/inbox', {
      method: 'POST',
      headers: {
        'Date': new Date().toUTCString(),
        'Digest': 'SHA-256=abc'
      }
    })
    const result = await verifyHttpSignature(request, 'public-key-pem')
    assert.strictEqual(result, false)
  })

  // Add more tests for valid and invalid signatures
})
