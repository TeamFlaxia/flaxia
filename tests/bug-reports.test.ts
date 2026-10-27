import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { Bindings, Variables } from '../functions/api/types.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.')
      ) {
        return nextResolve(`${specifier.replace(/\.js$/, '')}.ts`, context);
      }
      throw error;
    }
  },
});

const { csrfProtection } = await import('../functions/api/helpers.ts');
const { default: bugReports } = await import('../functions/api/routes/bug-reports.ts');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7Z8AAAAASUVORK5CYII=',
  'base64',
);

class MemoryKV {
  private values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class TestD1 {
  private db = new DatabaseSync(':memory:');

  constructor() {
    this.db.exec(readFileSync(new URL('../migrations/0113_bug_report_submissions.sql', import.meta.url), 'utf8'));
  }

  prepare(sql: string) {
    return {
      bind: (...args: (string | number | null)[]) => ({
        run: async () => ({ meta: { changes: Number(this.db.prepare(sql).run(...args).changes) } }),
        first: async () => this.db.prepare(sql).get(...args) ?? null,
      }),
    };
  }
}

function makeApp(authenticated = true) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set(
      'user',
      authenticated
        ? ({ id: 'private-user-id', username: 'private-user', email: 'private@example.com' } as Variables['user'])
        : null,
    );
    await next();
  });
  app.use('*', csrfProtection);
  app.route('/api', bugReports);

  const uploaded = new Map<string, Uint8Array>();
  const env = {
    BASE_URL: 'https://flaxia.app',
    CACHE: new MemoryKV(),
    DB: new TestD1(),
    BUCKET: {
      async put(key: string, value: ArrayBufferView | ArrayBuffer | string) {
        uploaded.set(key, new Uint8Array(typeof value === 'string' ? Buffer.from(value) : value));
      },
      async delete(key: string) {
        uploaded.delete(key);
      },
    },
    GITHUB_APP_ID: '12345',
    GITHUB_APP_INSTALLATION_ID: '67890',
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
  } as unknown as Bindings;
  return { app, env, uploaded };
}

function makeForm(
  options: {
    summary?: string;
    feature?: string;
    screenshot?: Blob;
    screenshotConsent?: boolean;
    diagnosticsConsent?: boolean;
    publicConfirmation?: boolean;
  } = {},
): FormData {
  const form = new FormData();
  form.set('feature', options.feature ?? 'timeline');
  form.set('summary', options.summary ?? 'Timeline shows an error');
  form.set('details', 'The timeline displays an unexpected error.');
  form.set('reproduction', 'Open the timeline.');
  form.set('language', 'en');
  form.set('publicConfirmation', options.publicConfirmation === false ? 'false' : 'true');
  form.set('screenshotConsent', options.screenshotConsent ? 'true' : 'false');
  form.set('diagnosticsConsent', options.diagnosticsConsent ? 'true' : 'false');
  if (options.diagnosticsConsent) {
    form.set(
      'diagnostics',
      JSON.stringify({
        appVersion: '0.1.0',
        commit: 'abc123',
        os: 'Linux',
        browser: 'Chrome 140',
        occurredAt: '2026-10-27T00:00:00.000Z',
        email: 'must-not-be-included@example.com',
      }),
    );
  }
  if (options.screenshot) form.set('screenshot', options.screenshot, 'private-name.png');
  return form;
}

async function withGitHubMock<T>(fn: (calls: Array<{ url: string; body: string; auth: string | null }>) => Promise<T>) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: string; auth: string | null }> = [];
  let issueNumber = 40;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '', auth: headers.get('Authorization') });
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'installation-token' }), { status: 201 });
    }
    if (url.endsWith('/issues')) {
      issueNumber++;
      return new Response(
        JSON.stringify({ number: issueNumber, html_url: `https://github.com/TeamFlaxia/flaxia/issues/${issueNumber}` }),
        { status: 201 },
      );
    }
    return new Response('Unexpected endpoint', { status: 404 });
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('bug reports require an authenticated session and pass CSRF validation', async () => {
  const anonymous = makeApp(false);
  const unauthorized = await anonymous.app.request(
    '/api/bug-reports',
    { method: 'POST', body: makeForm() },
    anonymous.env,
  );
  assert.equal(unauthorized.status, 401);

  const authenticated = makeApp(true);
  const csrf = await authenticated.app.request(
    '/api/bug-reports',
    { method: 'POST', headers: { Origin: 'https://attacker.example' }, body: makeForm() },
    authenticated.env,
  );
  assert.equal(csrf.status, 403);
});

test('bug report validation requires the final public confirmation', async () => {
  const { app, env } = makeApp();
  await withGitHubMock(async (calls) => {
    const response = await app.request(
      '/api/bug-reports',
      { method: 'POST', body: makeForm({ publicConfirmation: false }) },
      env,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });
});

test('valid reports create one public issue without account or unconsented diagnostics data', async () => {
  const { app, env } = makeApp();
  await withGitHubMock(async (calls) => {
    const response = await app.request('/api/bug-reports', { method: 'POST', body: makeForm() }, env);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      issueNumber: 41,
      issueUrl: 'https://github.com/TeamFlaxia/flaxia/issues/41',
    });

    const tokenRequest = calls.find((call) => call.url.includes('/access_tokens'));
    const issueRequest = calls.find((call) => call.url.endsWith('/issues'));
    assert.ok(tokenRequest?.auth?.startsWith('Bearer '));
    assert.equal(tokenRequest?.auth?.split('.').length, 3);
    assert.ok(issueRequest);
    const issue = JSON.parse(issueRequest.body) as { title: string; body: string; labels: string[] };
    assert.equal(issue.title, '[Bug][timeline] Timeline shows an error');
    assert.deepEqual(issue.labels, ['bug', 'user-report']);
    assert.match(issue.body, /The timeline displays an unexpected error/);
    assert.doesNotMatch(issue.body, /private-user|private@example\.com|must-not-be-included/);
  });
});

test('diagnostics are included only after consent and are escaped in the public issue', async () => {
  const { app, env } = makeApp();
  await withGitHubMock(async (calls) => {
    const form = makeForm({ diagnosticsConsent: true });
    form.set(
      'diagnostics',
      JSON.stringify({
        appVersion: '<script>alert(1)</script>',
        commit: 'abc123',
        os: 'Linux',
        browser: 'Chrome 140',
        occurredAt: '2026-10-27T00:00:00.000Z',
      }),
    );
    const response = await app.request('/api/bug-reports', { method: 'POST', body: form }, env);
    assert.equal(response.status, 201);
    const issueRequest = calls.find((call) => call.url.endsWith('/issues'));
    const issue = JSON.parse(issueRequest?.body ?? '{}') as { body: string };
    assert.match(issue.body, /Diagnostics \(user consented\)/);
    assert.match(issue.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(issue.body, /must-not-be-included/);
  });
});

test('screenshots require public-sharing consent and are validated before upload', async () => {
  const { app, env, uploaded } = makeApp();
  const image = new Blob([pngBytes], { type: 'image/png' });
  await withGitHubMock(async (calls) => {
    const noConsent = await app.request(
      '/api/bug-reports',
      { method: 'POST', body: makeForm({ screenshot: image }) },
      env,
    );
    assert.equal(noConsent.status, 400);
    assert.equal(uploaded.size, 0);

    const withConsent = await app.request(
      '/api/bug-reports',
      { method: 'POST', body: makeForm({ screenshot: image, screenshotConsent: true }) },
      env,
    );
    assert.equal(withConsent.status, 201);
    assert.equal(uploaded.size, 1);
    const issueRequest = calls.find((call) => call.url.endsWith('/issues'));
    const issue = JSON.parse(issueRequest?.body ?? '{}') as { body: string };
    assert.match(issue.body, /Screenshot \(user consented to public sharing\)/);
    assert.match(issue.body, /https:\/\/flaxia\.app\/api\/images\/bug-reports\//);
    assert.doesNotMatch(issue.body, /private-name\.png/);
  });
});

test('rate limiting caps submissions at three per user per day and identical retries are deduplicated', async () => {
  const { app, env } = makeApp();
  await withGitHubMock(async (calls) => {
    const firstForm = makeForm();
    const first = await app.request('/api/bug-reports', { method: 'POST', body: firstForm }, env);
    assert.equal(first.status, 201);

    const duplicate = await app.request('/api/bug-reports', { method: 'POST', body: makeForm() }, env);
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as { issueNumber: number }).issueNumber, 41);

    for (const summary of ['Second report', 'Third report']) {
      const response = await app.request('/api/bug-reports', { method: 'POST', body: makeForm({ summary }) }, env);
      assert.equal(response.status, 201);
    }
    const limited = await app.request(
      '/api/bug-reports',
      { method: 'POST', body: makeForm({ summary: 'Fourth report' }) },
      env,
    );
    assert.equal(limited.status, 429);
    assert.equal(calls.filter((call) => call.url.endsWith('/issues')).length, 3);
  });
});

test('concurrent identical and distinct reports reserve quota atomically', async () => {
  const { app, env } = makeApp();
  await withGitHubMock(async (calls) => {
    const identical = await Promise.all(
      Array.from({ length: 8 }, () => app.request('/api/bug-reports', { method: 'POST', body: makeForm() }, env)),
    );
    assert.equal(identical.filter((r) => r.status === 201).length, 1);
    assert.ok(identical.every((r) => [200, 201, 409].includes(r.status)));
    const distinct = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.request('/api/bug-reports', { method: 'POST', body: makeForm({ summary: `Concurrent ${i}` }) }, env),
      ),
    );
    assert.equal(distinct.filter((r) => r.status === 201).length, 2);
    assert.equal(distinct.filter((r) => r.status === 429).length, 6);
    assert.equal(calls.filter((call) => call.url.endsWith('/issues')).length, 3);
  });
});

test('definite token failures release quota for retries', async () => {
  const { app, env } = makeApp();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
  try {
    for (let i = 0; i < 4; i++) {
      const response = await app.request('/api/bug-reports', { method: 'POST', body: makeForm() }, env);
      assert.equal(response.status, 502);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  await withGitHubMock(async () => {
    const response = await app.request('/api/bug-reports', { method: 'POST', body: makeForm() }, env);
    assert.equal(response.status, 201);
  });
});

test('rejects oversized streamed multipart bodies without Content-Length', async () => {
  const { app, env } = makeApp();
  const bytes = new Uint8Array(5 * 1024 * 1024 + 32769);
  const request = new Request('http://localhost/api/bug-reports', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=test' },
    body: new Blob([bytes]),
  });
  assert.equal(request.headers.get('content-length'), null);
  const response = await app.fetch(request, env);
  assert.equal(response.status, 413);
});
