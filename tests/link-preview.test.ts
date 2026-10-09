import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { authMiddleware } from '../functions/api/helpers.ts';
import linkPreviewRouter from '../functions/api/routes/link-preview.ts';
import type { Bindings, Variables } from '../functions/api/types.ts';
import { loadLinkPreview } from '../src/lib/link-preview.ts';

const VALID_COOKIE = 'session=valid-preview-session';
const PUBLIC_URL = 'https://example.com/article';

function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('/api/*', authMiddleware);
  app.route('/api', linkPreviewRouter);
  return app;
}

// Model the session lookup used by authMiddleware without contacting D1.
// Both the middleware and the real link-preview route run on this Hono app.
function createEnv(options: { rateLimited?: boolean } = {}): Bindings {
  return {
    DB: {
      prepare: () => ({
        bind: (token: string) => ({
          first: async () =>
            token === 'valid-preview-session' ? { id: 'preview-user', username: 'tester', role: 'user' } : null,
        }),
      }),
    },
    CACHE: options.rateLimited
      ? {
          get: async () => '30',
          put: async () => {
            throw new Error('rate-limited requests must not update KV');
          },
        }
      : undefined,
  } as unknown as Bindings;
}

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
  throw new Error('unexpected outbound fetch');
};

describe('GET /api/link-preview: auth and SSRF boundaries', () => {
  it('returns 401 for guests before URL validation or any outbound fetch', async () => {
    await withStubbedFetch(neverFetch, async (requests) => {
      const app = createApp();
      for (const path of [
        '/api/link-preview',
        '/api/link-preview?url=https%3A%2F%2Fexample.com%2F',
        '/api/link-preview?url=http%3A%2F%2F127.0.0.1%2Fsecret',
      ]) {
        const response = await app.request(path, undefined, createEnv());
        assert.equal(response.status, 401, path);
        assert.deepEqual(await response.json(), { error: 'Unauthorized' });
      }
      assert.deepEqual(requests, []);
    });
  });

  it('returns 401 for invalid session cookies without an outbound fetch', async () => {
    await withStubbedFetch(neverFetch, async (requests) => {
      const response = await createApp().request(
        '/api/link-preview?url=' + encodeURIComponent(PUBLIC_URL),
        { headers: { Cookie: 'session=expired-or-forged' } },
        createEnv(),
      );
      assert.equal(response.status, 401);
      assert.deepEqual(requests, []);
    });
  });

  it('allows a valid session through authentication and rejects a missing URL', async () => {
    await withStubbedFetch(neverFetch, async (requests) => {
      const response = await createApp().request(
        '/api/link-preview',
        { headers: { Cookie: VALID_COOKIE } },
        createEnv(),
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'Missing url parameter' });
      assert.deepEqual(requests, []);
    });
  });

  it('blocks private, mapped IPv6 and non-HTTP URLs for logged-in users', async () => {
    await withStubbedFetch(neverFetch, async (requests) => {
      const app = createApp();
      for (const url of [
        'http://127.0.0.1/secret',
        'http://[::ffff:127.0.0.1]/secret',
        'http://metadata.google.internal/latest',
        'file:///etc/passwd',
      ]) {
        const response = await app.request(
          '/api/link-preview?url=' + encodeURIComponent(url),
          { headers: { Cookie: VALID_COOKIE } },
          createEnv(),
        );
        assert.equal(response.status, 400, url);
      }
      assert.deepEqual(requests, []);
    });
  });

  it('fetches a public HTML page and returns OGP with a valid session', async () => {
    await withStubbedFetch(
      () =>
        new Response(
          '<html><head><meta property="og:title" content="Example title"><meta property="og:description" content="Example description"></head></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        ),
      async (requests) => {
        const response = await createApp().request(
          '/api/link-preview?url=' + encodeURIComponent(PUBLIC_URL),
          { headers: { Cookie: VALID_COOKIE } },
          createEnv(),
        );
        assert.equal(response.status, 200);
        const data = (await response.json()) as { title: string; description: string; url: string };
        assert.equal(data.title, 'Example title');
        assert.equal(data.description, 'Example description');
        assert.equal(data.url, PUBLIC_URL);
        assert.deepEqual(requests, [PUBLIC_URL]);
      },
    );
  });

  it('rejects redirects into a private network without following them', async () => {
    await withStubbedFetch(
      () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }),
      async (requests) => {
        const response = await createApp().request(
          '/api/link-preview?url=' + encodeURIComponent(PUBLIC_URL),
          { headers: { Cookie: VALID_COOKIE } },
          createEnv(),
        );
        assert.equal(response.status, 400);
        assert.deepEqual(requests, [PUBLIC_URL]);
      },
    );
  });

  it('returns 429 before an outbound fetch when the user exceeds the limit', async () => {
    await withStubbedFetch(neverFetch, async (requests) => {
      const response = await createApp().request(
        '/api/link-preview?url=' + encodeURIComponent(PUBLIC_URL),
        { headers: { Cookie: VALID_COOKIE } },
        createEnv({ rateLimited: true }),
      );
      assert.equal(response.status, 429);
      assert.deepEqual(requests, []);
    });
  });
});

describe('loadLinkPreview: guest UI policy', () => {
  it('does not request a preview for guests, including on public post URLs', async () => {
    await withStubbedFetch(neverFetch, async (requests) => {
      loadLinkPreview('Look: ' + PUBLIC_URL, {} as HTMLElement, false);
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

  it('does not request unsupported media links even when authenticated', async () => {
    await withStubbedFetch(neverFetch, async (requests) => {
      loadLinkPreview('https://example.com/api/images/test.jpg', {} as HTMLElement, true);
      loadLinkPreview('not a URL', {} as HTMLElement, true);
      assert.deepEqual(requests, []);
    });
  });
});
