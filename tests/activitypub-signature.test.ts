import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exportPrivateKey, exportPublicKey, generateKeyPair } from '../functions/lib/activitypub/crypto.ts';
import { isPrivatePeerAllowed, resolveActorPublicKey } from '../functions/lib/activitypub/fetch.ts';
import {
  buildSigningString,
  parseSignatureHeader,
  signRequest,
  verifyDigest,
  verifyHttpSignature,
} from '../functions/lib/activitypub/signature.ts';

const URL_UNDER_TEST = 'https://remote.example/inbox';

async function keyPair() {
  const pair = await generateKeyPair();
  return {
    privateKeyPem: await exportPrivateKey(pair.privateKey),
    publicKeyPem: await exportPublicKey(pair.publicKey),
  };
}

/** Sign a request with an explicit list of signed headers. */
async function signWith(
  url: string,
  body: string,
  privateKeyPem: string,
  keyId: string,
  signedHeaders: string,
  extraHeaders: Record<string, string> = {},
): Promise<Headers> {
  const headers = await signRequest(url, body, privateKeyPem, keyId);
  const encoder = new TextEncoder();
  const digestBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  const digest = btoa(String.fromCharCode(...new Uint8Array(digestBuffer)));
  const date = headers.get('Date') ?? new Date().toUTCString();
  const parsedUrl = new URL(url);
  const lines: string[] = [];
  for (const header of signedHeaders.split(' ')) {
    if (header === '(request-target)') lines.push(`(request-target): post ${parsedUrl.pathname}${parsedUrl.search}`);
    else if (header === 'digest') lines.push(`digest: sha-256=${digest}`);
    else if (header === 'host') lines.push(`host: ${parsedUrl.host}`);
    else if (header === 'date') lines.push(`date: ${date}`);
  }
  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await importKey(privateKeyPem),
    encoder.encode(lines.join('\n')),
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  headers.set(
    'Signature',
    `keyId="${keyId}",algorithm="rsa-sha256",headers="${signedHeaders}",signature="${signature}"`,
  );
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return headers;
}

async function importKey(pem: string): Promise<CryptoKey> {
  const contents = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binary = atob(contents);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return crypto.subtle.importKey('pkcs8', bytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
}

describe('ActivityPub signature header parsing', () => {
  it('parses the parameters peers send', () => {
    const parsed = parseSignatureHeader(
      'keyId="https://remote.example/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="abc%3D"',
    );
    assert.equal(parsed.keyId, 'https://remote.example/users/alice#main-key');
    assert.equal(parsed.algorithm, 'rsa-sha256');
    assert.deepEqual(parsed.headers, ['(request-target)', 'host', 'date', 'digest']);
    assert.equal(parsed.signature, 'abc%3D');
  });

  it('parses the created and expires parameters', () => {
    const parsed = parseSignatureHeader(
      'keyId="https://remote.example/users/alice#main-key",created="1700000000",expires="1700003600",headers="(request-target) host date",signature="abc"',
    );
    assert.equal(parsed.created, 1700000000);
    assert.equal(parsed.expires, 1700003600);
  });

  it('rejects a header without the required parameters', () => {
    assert.throws(() => parseSignatureHeader('headers="(request-target)",signature="abc"'));
    assert.throws(() => parseSignatureHeader('keyId="https://remote.example/#k",signature="abc"'));
  });
});

describe('ActivityPub signature verification', () => {
  it('accepts a signature produced by the actor key', async () => {
    const { privateKeyPem, publicKeyPem } = await keyPair();
    const body = '{"type":"Follow"}';
    const headers = await signRequest(
      URL_UNDER_TEST,
      body,
      privateKeyPem,
      'https://remote.example/users/alice#main-key',
    );
    headers.set('Host', 'remote.example');
    const request = new Request(URL_UNDER_TEST, { method: 'POST', headers, body });
    assert.equal(await verifyHttpSignature(request, publicKeyPem), true);
    assert.equal(await verifyDigest(request, body), true);
  });

  it('rejects a request whose body was replaced', async () => {
    const { privateKeyPem, publicKeyPem } = await keyPair();
    const headers = await signRequest(
      URL_UNDER_TEST,
      '{"type":"Follow"}',
      privateKeyPem,
      'https://remote.example/users/alice#main-key',
    );
    headers.set('Host', 'remote.example');
    const request = new Request(URL_UNDER_TEST, { method: 'POST', headers, body: '{"type":"Delete"}' });
    assert.equal(await verifyDigest(request, '{"type":"Delete"}'), false);
    assert.equal(await verifyHttpSignature(request, publicKeyPem), true);
  });

  it('rejects a signature outside the accepted time window', async () => {
    const { privateKeyPem, publicKeyPem } = await keyPair();
    const headers = await signRequest(
      URL_UNDER_TEST,
      '{}',
      privateKeyPem,
      'https://remote.example/users/alice#main-key',
    );
    headers.set('Host', 'remote.example');
    headers.set('Date', new Date(Date.now() - 60 * 60 * 1000).toUTCString());
    const request = new Request(URL_UNDER_TEST, { method: 'POST', headers, body: '{}' });
    assert.equal(await verifyHttpSignature(request, publicKeyPem), false);
  });

  it('rejects a POST whose body is not covered by the signature', async () => {
    const { privateKeyPem, publicKeyPem } = await keyPair();
    const headers = await signWith(
      URL_UNDER_TEST,
      '{"type":"Create"}',
      privateKeyPem,
      'https://remote.example/users/alice#main-key',
      '(request-target) host date',
    );
    headers.set('Host', 'remote.example');
    const request = new Request(URL_UNDER_TEST, { method: 'POST', headers, body: '{"type":"Create"}' });
    assert.equal(await verifyHttpSignature(request, publicKeyPem), false);
  });

  it('accepts a signature that does not cover the host for the actor origin', async () => {
    const { privateKeyPem, publicKeyPem } = await keyPair();
    const headers = await signWith(
      URL_UNDER_TEST,
      '{"type":"Create"}',
      privateKeyPem,
      'https://remote.example/users/alice#main-key',
      '(request-target) date digest',
    );
    headers.set('Host', 'remote.example');
    const request = new Request(URL_UNDER_TEST, { method: 'POST', headers, body: '{"type":"Create"}' });
    assert.equal(await verifyHttpSignature(request, publicKeyPem, { expectedHost: 'remote.example' }), true);
    assert.equal(await verifyHttpSignature(request, publicKeyPem, { expectedHost: 'other.example' }), false);
  });

  it('rejects a signature whose signed host does not match the request', async () => {
    const { privateKeyPem, publicKeyPem } = await keyPair();
    const headers = await signWith(
      URL_UNDER_TEST,
      '{"type":"Create"}',
      privateKeyPem,
      'https://remote.example/users/alice#main-key',
      '(request-target) host date digest',
      { Host: 'evil.example' },
    );
    const request = new Request(URL_UNDER_TEST, { method: 'POST', headers, body: '{"type":"Create"}' });
    assert.equal(await verifyHttpSignature(request, publicKeyPem), false);
  });

  it('rejects an expired signature that carries an expires parameter', async () => {
    const { privateKeyPem, publicKeyPem } = await keyPair();
    const headers = await signRequest(
      URL_UNDER_TEST,
      '{}',
      privateKeyPem,
      'https://remote.example/users/alice#main-key',
    );
    headers.set('Host', 'remote.example');
    const parsed = parseSignatureHeader(headers.get('Signature') ?? '');
    headers.set(
      'Signature',
      `keyId="${parsed.keyId}",created="${Math.floor(Date.now() / 1000) - 7200}",expires="${Math.floor(Date.now() / 1000) - 3600}",headers="${parsed.headers.join(' ')}",signature="${parsed.signature}"`,
    );
    const request = new Request(URL_UNDER_TEST, { method: 'POST', headers, body: '{}' });
    assert.equal(await verifyHttpSignature(request, publicKeyPem), false);
  });

  it('builds the signing string from the request', () => {
    const request = new Request('https://remote.example/inbox?x=1', {
      method: 'POST',
      headers: { host: 'remote.example', date: 'Wed, 01 Jan 2026 00:00:00 GMT' },
    });
    const signingString = buildSigningString(request, ['(request-target)', 'host', 'date']);
    assert.equal(
      signingString,
      '(request-target): post /inbox?x=1\nhost: remote.example\ndate: Wed, 01 Jan 2026 00:00:00 GMT',
    );
  });
});

describe('ActivityPub key resolution', () => {
  it('resolves the key from the keyId document', async () => {
    const { publicKeyPem } = await keyPair();
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify({
          id: 'https://remote.example/users/alice#main-key',
          owner: 'https://remote.example/users/alice',
          publicKeyPem,
        }),
        { headers: { 'Content-Type': 'application/activity+json' } },
      );
    }) as typeof fetch;
    try {
      const resolved = await resolveActorPublicKey(
        'https://remote.example/users/alice',
        {},
        'https://remote.example/users/alice#main-key',
      );
      assert.equal(resolved, publicKeyPem);
      assert.equal(requested.length, 1);
      assert.equal(requested[0], 'https://remote.example/users/alice');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never takes a key from another origin than the actor', async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ publicKey: { publicKeyPem: '-----BEGIN PUBLIC KEY-----evil' } }), {
        headers: { 'Content-Type': 'application/activity+json' },
      });
    }) as typeof fetch;
    try {
      const resolved = await resolveActorPublicKey(
        'https://remote.example/users/alice',
        {},
        'https://evil.example/users/alice#main-key',
      );
      assert.ok(!requested.some((url) => url.startsWith('https://evil.example')));
      assert.ok(requested.every((url) => url.startsWith('https://remote.example')));
      assert.equal(resolved, '-----BEGIN PUBLIC KEY-----evil');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('ActivityPub private peer allow list', () => {
  it('is inert outside of test and development', () => {
    assert.equal(isPrivatePeerAllowed({ ENVIRONMENT: 'production' }, 'localhost'), false);
    assert.equal(
      isPrivatePeerAllowed({ ENVIRONMENT: 'production', AP_ALLOWED_PRIVATE_PEERS: 'localhost' }, 'localhost'),
      false,
    );
    assert.equal(isPrivatePeerAllowed({}, 'localhost'), false);
  });

  it('allows the listed host in the test environment', () => {
    const env = { ENVIRONMENT: 'test', AP_ALLOWED_PRIVATE_PEERS: 'localhost,127.0.0.1' };
    assert.equal(isPrivatePeerAllowed(env, 'localhost'), true);
    assert.equal(isPrivatePeerAllowed(env, '127.0.0.1'), true);
    assert.equal(isPrivatePeerAllowed(env, 'evil.example'), false);
  });
});
