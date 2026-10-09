// Keep this unit test browser-independent: Node's ESM runner cannot resolve
// the extensionless imports used by the Cloudflare API routes. Their session
// enforcement is covered by link-preview-integration.test.ts, which runs
// against Wrangler; redirect/SSRF behavior is covered by url-guard.test.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadLinkPreview } from '../src/lib/link-preview.ts';

const PUBLIC_URL = 'https://example.com/article';

async function withStubbedFetch(
  respond: (url: string) => Response | Promise<Response>,
  run: (requests: string[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return respond(url);
  }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

const neverFetch = (): never => {
  throw new Error('unexpected preview fetch');
};

describe('loadLinkPreview: guest UI policy', () => {
  it('does not request a preview for guests, including on public post URLs', async () => {
    await withStubbedFetch(neverFetch, async (requests) => {
      loadLinkPreview('Look: ' + PUBLIC_URL, {} as HTMLElement, false);
      loadLinkPreview('Look: www.example.com/article', {} as HTMLElement, false);
      assert.deepEqual(requests, []);
    });
  });

  it('still requests previews for authenticated users', async () => {
    await withStubbedFetch(
      () => Response.json({ url: '' }), // No card to render in this DOM-free test.
      async (requests) => {
        loadLinkPreview('Look: ' + PUBLIC_URL, {} as HTMLElement, true);
        assert.deepEqual(requests, ['/api/link-preview?url=' + encodeURIComponent(PUBLIC_URL)]);
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    );
  });

  it('normalizes www links to https for signed-in users', async () => {
    await withStubbedFetch(
      () => Response.json({ url: '' }),
      async (requests) => {
        loadLinkPreview('Look: www.example.com/article', {} as HTMLElement, true);
        assert.deepEqual(requests, ['/api/link-preview?url=' + encodeURIComponent(PUBLIC_URL)]);
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    );
  });

  it('does not request unsupported media links or non-URLs, even when signed in', async () => {
    await withStubbedFetch(neverFetch, async (requests) => {
      loadLinkPreview('https://example.com/api/images/test.jpg', {} as HTMLElement, true);
      loadLinkPreview('https://example.com/api/zip/test.zip', {} as HTMLElement, true);
      loadLinkPreview('not a URL', {} as HTMLElement, true);
      loadLinkPreview('', {} as HTMLElement, true);
      assert.deepEqual(requests, []);
    });
  });
});
