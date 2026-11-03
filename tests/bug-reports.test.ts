import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
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
const { cleanupExpiredBugReportSubmissions } = await import('../functions/lib/bug-report-store.ts');
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
    for (const migration of ['0097_file_scans_blocklist.sql', '0128_bug_report_submissions.sql']) {
      this.db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
  }

  /** Test hook: make the synchronous upload scan reject these exact bytes. */
  blockSha256(sha256: string): void {
    this.db.prepare("INSERT INTO file_blocklist (kind, value, reason) VALUES ('sha256', ?, 'test')").run(sha256);
  }

  prepare(sql: string) {
    const run = (...args: (string | number | null)[]) => ({
      meta: { changes: Number(this.db.prepare(sql).run(...args).changes) },
    });
    const first = (...args: (string | number | null)[]) => this.db.prepare(sql).get(...args) ?? null;
    const all = (...args: (string | number | null)[]) => ({ results: this.db.prepare(sql).all(...args) });
    return {
      bind: (...args: (string | number | null)[]) => ({
        run: async () => run(...args),
        first: async () => first(...args),
        all: async () => all(...args),
      }),
      run: async () => run(),
      first: async () => first(),
      all: async () => all(),
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

interface GitHubCall {
  url: string;
  body: string;
  auth: string | null;
  userAgent: string | null;
}

async function withGitHubMock<T>(fn: (calls: GitHubCall[]) => Promise<T>) {
  const originalFetch = globalThis.fetch;
  const calls: GitHubCall[] = [];
  let issueNumber = 40;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : '',
      auth: headers.get('Authorization'),
      userAgent: headers.get('User-Agent'),
    });
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

/** Model a repository where `user-report` does not exist yet. */
async function withMissingLabelMock<T>(fn: (calls: GitHubCall[]) => Promise<T>) {
  const originalFetch = globalThis.fetch;
  const calls: GitHubCall[] = [];
  let labelsCreated = false;
  let issueNumber = 60;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : '',
      auth: headers.get('Authorization'),
      userAgent: headers.get('User-Agent'),
    });
    if (url.includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'installation-token' }), { status: 201 });
    }
    if (url.endsWith('/labels')) {
      // GitHub rejects requests without an identifying User-Agent.
      if (!headers.get('User-Agent')) return new Response('User agent required', { status: 403 });
      labelsCreated = true;
      return new Response('{}', { status: 201 });
    }
    if (url.endsWith('/issues')) {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { labels?: unknown }) : {};
      if (Array.isArray(body.labels) && body.labels.length > 0 && !labelsCreated) {
        return new Response(
          JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels' }] }),
          { status: 422 },
        );
      }
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
  assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });

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
    assert.match(tokenRequest?.userAgent ?? '', /^Flaxia-Bug-Report\//);
    assert.ok(issueRequest);
    assert.match(issueRequest.userAgent ?? '', /^Flaxia-Bug-Report\//);
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

test('diagnostics sent without consent are ignored', async () => {
  const { app, env } = makeApp();
  await withGitHubMock(async (calls) => {
    const form = makeForm();
    form.set(
      'diagnostics',
      JSON.stringify({
        appVersion: 'unconsented-marker',
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
    assert.doesNotMatch(issue.body, /unconsented-marker|Diagnostics \(user consented\)/);
  });
});

test('oversized diagnostics payloads are rejected before contacting GitHub', async () => {
  const { app, env } = makeApp();
  await withGitHubMock(async (calls) => {
    const form = makeForm({ diagnosticsConsent: true });
    form.set(
      'diagnostics',
      JSON.stringify({
        appVersion: 'x'.repeat(5000),
        commit: 'abc123',
        os: 'Linux',
        browser: 'Chrome 140',
        occurredAt: '2026-10-27T00:00:00.000Z',
      }),
    );
    const response = await app.request('/api/bug-reports', { method: 'POST', body: form }, env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_diagnostics' });
    assert.deepEqual(calls, []);
  });
});

test('missing labels are created with an identifying User-Agent and the issue retries with them', async () => {
  const { app, env } = makeApp();
  await withMissingLabelMock(async (calls) => {
    const response = await app.request('/api/bug-reports', { method: 'POST', body: makeForm() }, env);
    assert.equal(response.status, 201);

    const labelRequests = calls.filter((call) => call.url.endsWith('/labels'));
    assert.deepEqual(
      labelRequests.map((call) => (JSON.parse(call.body) as { name: string }).name),
      ['bug', 'user-report'],
    );
    assert.ok(labelRequests.every((call) => call.userAgent?.startsWith('Flaxia-Bug-Report/')));

    const issueRequests = calls.filter((call) => call.url.endsWith('/issues'));
    assert.equal(issueRequests.length, 2);
    const issue = JSON.parse(issueRequests[1].body) as { labels: string[] };
    assert.deepEqual(issue.labels, ['bug', 'user-report']);
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

test('blocklisted screenshot bytes are rejected before any R2 upload', async () => {
  const { app, env, uploaded } = makeApp();
  const sha256 = createHash('sha256').update(pngBytes).digest('hex');
  (env.DB as TestD1).blockSha256(sha256);

  await withGitHubMock(async (calls) => {
    const response = await app.request(
      '/api/bug-reports',
      {
        method: 'POST',
        body: makeForm({
          screenshot: new Blob([pngBytes], { type: 'image/png' }),
          screenshotConsent: true,
        }),
      },
      env,
    );
    assert.equal(response.status, 400);
    assert.equal(uploaded.size, 0);
    assert.equal(calls.filter((call) => call.url.endsWith('/issues')).length, 0);
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

test('expired reservations are deleted by the scheduled cleanup', async () => {
  const { env } = makeApp();
  const db = env.DB as TestD1;
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(`
    INSERT INTO bug_report_submissions (user_id, fingerprint, reservation_id, window_id, state, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  await insert.bind('expired-user', 'a'.repeat(64), 'expired-reservation', 1, 'created', now - 1).run();
  await insert.bind('active-user', 'b'.repeat(64), 'active-reservation', 1, 'created', now + 60).run();

  const removed = await cleanupExpiredBugReportSubmissions(db as unknown as D1Database, now);
  assert.equal(removed, 1);
  const remaining = await db.prepare('SELECT user_id FROM bug_report_submissions').all<{ user_id: string }>();
  assert.deepEqual(
    remaining.results.map((row) => row.user_id),
    ['active-user'],
  );
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
