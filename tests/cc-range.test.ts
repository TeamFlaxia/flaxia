import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createCcRangeUrl, handleCcRangeRequest, verifyCcRangeTicket } from '../functions/lib/cc-range.ts';

const WARC_PATH =
  'crawl-data/CC-MAIN-2026-43/segments/1700000000000.0/warc/CC-MAIN-20260101000000-20260101010000-00000.warc.gz';

const SECRET = 'test-secret';
const BASE_URL = 'https://flaxia.app';
const env = { CROWD_WEBHOOK_SECRET: SECRET, BASE_URL };

async function ticketFor(overrides: Partial<{ warcFilename: string; offset: number; length: number }> = {}) {
  const url = await createCcRangeUrl(SECRET, BASE_URL, {
    warcFilename: WARC_PATH,
    offset: 10,
    length: 4,
    ...overrides,
  });
  return { url, ticket: new URL(url).searchParams.get('ticket') ?? '' };
}

describe('cc-range tickets', () => {
  it('mints a ticket that binds the exact WARC path and range', async () => {
    const { ticket } = await ticketFor();
    const claims = await verifyCcRangeTicket(SECRET, ticket);
    assert.equal(claims?.warcFilename, WARC_PATH);
    assert.equal(claims?.offset, 10);
    assert.equal(claims?.length, 4);
  });

  it('rejects a tampered or expired ticket', async () => {
    const { ticket } = await ticketFor();
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('0') ? '1' : '0'}`;
    assert.equal(await verifyCcRangeTicket(SECRET, tampered), null);
    assert.equal(await verifyCcRangeTicket(SECRET, ticket, Date.now() + 31 * 60 * 1000), null);
  });

  it('rejects invalid paths, offsets and lengths', async () => {
    await assert.rejects(
      createCcRangeUrl(SECRET, BASE_URL, {
        warcFilename: 'https://evil.example/page.warc.gz',
        offset: 0,
        length: 1,
      }),
    );
    await assert.rejects(createCcRangeUrl(SECRET, BASE_URL, { warcFilename: WARC_PATH, offset: -1, length: 1 }));
    await assert.rejects(
      createCcRangeUrl(SECRET, BASE_URL, { warcFilename: WARC_PATH, offset: 0, length: 3 * 1024 * 1024 }),
    );
  });

  it('proxies the signed range and returns CORS headers', async () => {
    const { ticket } = await ticketFor({ length: 4 });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), `https://data.commoncrawl.org/${WARC_PATH}`);
      assert.equal(new Headers(init?.headers).get('range'), 'bytes=10-13');
      return new Response(bytes, {
        status: 206,
        headers: { 'content-range': 'bytes 10-13/100', 'content-type': 'application/octet-stream' },
      });
    }) as typeof fetch;
    try {
      const response = await handleCcRangeRequest(
        new Request(`https://flaxia.app/api/crowd/cc-range?ticket=${encodeURIComponent(ticket)}`),
        env,
      );
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(response.headers.get('content-range'), 'bytes 10-13/100');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects unsigned requests', async () => {
    const response = await handleCcRangeRequest(new Request('https://flaxia.app/api/crowd/cc-range'), env);
    assert.equal(response.status, 401);
  });

  it('rejects a ticket whose expiry is implausibly far in the future', async () => {
    const claims = { v: 1, warcFilename: WARC_PATH, offset: 0, length: 1, exp: Date.now() + 60 * 60 * 1000 };
    const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', SECRET).update(`flaxia-cc-range-v1.${body}`).digest('hex');
    assert.equal(await verifyCcRangeTicket(SECRET, `${body}.${sig}`), null);
  });

  it('passes through an upstream total of * and rejects inconsistent upstream ranges', async () => {
    const run = async (upstreamHeaders: Record<string, string>) => {
      const { ticket } = await ticketFor({ length: 4 });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: upstreamHeaders })) as typeof fetch;
      try {
        return await handleCcRangeRequest(
          new Request(`https://flaxia.app/api/crowd/cc-range?ticket=${encodeURIComponent(ticket)}`),
          env,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    };

    const unknown = await run({ 'content-range': 'bytes 10-13/*' });
    assert.equal(unknown.status, 206);
    assert.equal(unknown.headers.get('content-range'), 'bytes 10-13/*');

    const tooSmall = await run({ 'content-range': 'bytes 10-13/10' });
    assert.equal(tooSmall.status, 502);

    const wrongSpan = await run({ 'content-range': 'bytes 0-3/100' });
    assert.equal(wrongSpan.status, 502);
  });
});
