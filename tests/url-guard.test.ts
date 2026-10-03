import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkUrlForSsrf,
  fetchWithSsrfGuard,
  isPrivateHost,
  parsePublicHttpUrl,
  SsrfError,
} from '../functions/lib/url-guard.ts';

describe('url-guard', () => {
  it('classifies private, reserved and embedded IPv4 hosts', () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      assert.equal(isPrivateHost(host), true, host);
    }

    for (const host of [
      '[::1]',
      '::1',
      '[::]',
      '[fe80::1]',
      '[fc00::1]',
      '[fd12::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[2001:db8::1]',
      '[2002:7f00:1::]',
    ]) {
      assert.equal(isPrivateHost(host), true, host);
    }

    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '[2606:4700:4700::1111]']) {
      assert.equal(isPrivateHost(host), false, host);
    }
  });

  it('rejects internal hostnames and non-http(s) schemes', () => {
    for (const url of [
      'http://localhost/',
      'http://foo.localhost/',
      'http://svc.internal/',
      'http://metadata.google.internal/',
      'http://intranet/',
      'file:///etc/passwd',
      'ftp://example.com/',
    ]) {
      const parsed = (() => {
        try {
          return new URL(url);
        } catch {
          return null;
        }
      })();
      if (!parsed) continue;
      assert.notEqual(checkUrlForSsrf(parsed), null, url);
    }
  });

  it('allows public http(s) URLs', () => {
    assert.equal(checkUrlForSsrf(new URL('https://example.com/a?b=c')), null);
    assert.equal(checkUrlForSsrf(new URL('http://8.8.8.8/')), null);
  });

  it('re-validates every redirect hop and refuses private targets', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:8080/secret' } });
      }
      return new Response('should not be fetched');
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => fetchWithSsrfGuard('https://example.com/start'),
        (error: unknown) => error instanceof SsrfError,
      );
      assert.deepEqual(calls, ['https://example.com/start']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('follows public redirects after re-validation', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://example.com/start') {
        return new Response(null, { status: 301, headers: { Location: '/next' } });
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      const response = await fetchWithSsrfGuard('https://example.com/start');
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws SsrfError for invalid or private input URLs', () => {
    assert.throws(() => parsePublicHttpUrl('not a url'), SsrfError);
    assert.throws(() => parsePublicHttpUrl('http://localhost/'), SsrfError);
    assert.throws(() => parsePublicHttpUrl('http://[::ffff:127.0.0.1]/'), SsrfError);
  });
});
