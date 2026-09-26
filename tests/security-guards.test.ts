import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import testsRouter from '../functions/api/routes/tests.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.html') || full.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Source split into lines with comment-only lines removed.
 *
 * Only whole-line comments are dropped (`//` or block-comment `*` bodies), so
 * prose that quotes the banned token in a comment never trips a guard, while an
 * inline trailing comment on a real statement is still scanned. Deliberately
 * avoids stripping comments mid-line: a naive strip would truncate a line at a
 * `//` inside a string literal and could hide a real violation.
 */
function scanableSource(source: string): string[] {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  });
}

describe('security guards', () => {
  it('never sandboxes untrusted content with allow-same-origin', () => {
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'functions'))];
    // Both spellings count: the HTML/JSX attribute form and the imperative
    // setAttribute form. Matching only `sandbox = "..."` let a violation through
    // whenever the attribute was set from script.
    const pattern =
      /sandbox\s*=\s*["'][^"']*allow-same-origin|setAttribute\(\s*["']sandbox["']\s*,\s*["'][^"']*allow-same-origin/;
    const offenders = files
      .filter((file) => scanableSource(readFileSync(file, 'utf8')).some((line) => pattern.test(line)))
      .map((file) => relative(ROOT, file));
    assert.deepEqual(offenders, [], `allow-same-origin is banned: ${offenders.join(', ')}`);
  });

  it('serves the sandbox from a dedicated origin', () => {
    const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
    const get = (key: string) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];
    const sandboxOrigin = get('SANDBOX_ORIGIN');
    const baseUrl = get('BASE_URL');
    assert.ok(sandboxOrigin, 'SANDBOX_ORIGIN must be set');
    assert.notEqual(sandboxOrigin, baseUrl, 'SANDBOX_ORIGIN must differ from BASE_URL');
    assert.match(sandboxOrigin, /^https:\/\/sandbox\./);
  });

  it('does not gate test routes on request-derived data', () => {
    const src = readFileSync(join(ROOT, 'functions/api/routes/tests.ts'), 'utf8');
    assert.ok(!src.includes('c.req.url.includes'), 'test route guard must not inspect c.req.url');
    assert.ok(src.includes('c.env.ENVIRONMENT'), 'test route guard must use the ENVIRONMENT binding');
  });

  it('denies /api/test/reset outside the test environment', async () => {
    const env = {
      ENVIRONMENT: 'production',
      BASE_URL: 'https://flaxia.app',
      DB: {},
    } as never;
    // Defeat the spoofable legacy bypass: a crafted query string must not help.
    const res = await testsRouter.request('/api/test/reset?localhost:8788', { method: 'POST' }, env);
    assert.equal(res.status, 404);
  });

  it('rate-limits unauthenticated auth endpoints', () => {
    const src = readFileSync(join(ROOT, 'functions/api/routes/auth.ts'), 'utf8');
    assert.ok(src.includes("from '../../lib/rate-limit'"), 'auth must use the shared limiter');
    assert.ok(
      src.includes("startsWith('http://localhost')"),
      'auth rate limiter must bypass local/test environments for integration tests',
    );
    for (const scope of [
      'auth:register',
      'auth:login:ip',
      'auth:login:email',
      'auth:srp-start:ip',
      'auth:srp-start:email',
      'auth:srp-verify:ip',
      'auth:srp-verify:email',
    ]) {
      assert.ok(src.includes(scope), `missing rate limit for ${scope}`);
    }
  });

  it('uses ISO-8601 comparisons and constant-time password checks', () => {
    const src = readFileSync(join(ROOT, 'functions/lib/auth.ts'), 'utf8');
    assert.ok(!src.includes("expires_at > datetime('now')"), 'session/handshake expiry must compare ISO-8601 strings');
    assert.ok(src.includes("expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"));
    assert.ok(!src.includes('hashBytes.every('), 'password verification must be constant-time');
  });

  it('authorizes DM media before serving it', () => {
    const media = readFileSync(join(ROOT, 'functions/api/routes/media.ts'), 'utf8');
    assert.ok(media.includes('canAccessMediaKey'), 'media routes must authorize dm/ keys');
    assert.ok(media.includes("key.startsWith('dm/')"));
    const helpers = readFileSync(join(ROOT, 'functions/api/helpers.ts'), 'utf8');
    assert.ok(helpers.includes("path.includes('/dm/')"), 'auth middleware must resolve a session for DM media');

    const sandbox = readFileSync(join(ROOT, 'src/sandbox-worker.ts'), 'utf8');
    assert.ok(!sandbox.includes('dm/zip/'), 'sandbox origin must not serve private DM ZIPs');
    assert.ok(!sandbox.includes('dm/html/'), 'sandbox origin must not serve private DM HTML');
  });

  it('sets hardening response headers', () => {
    const headers = readFileSync(join(ROOT, 'public/_headers'), 'utf8');
    for (const header of [
      'Strict-Transport-Security',
      'X-Content-Type-Options: nosniff',
      "object-src 'none'",
      "base-uri 'self'",
    ]) {
      assert.ok(headers.includes(header), `_headers missing ${header}`);
    }
  });
});

// The invariants of docs/e2ee.md that are cheap to break and expensive to
// notice: a plaintext password field or a server-side unwrap both compile and
// pass ordinary tests while silently voiding the threat model.
describe('plaintext passwords are retired (docs/e2ee.md)', () => {
  it('no new code path puts a password in a request body', () => {
    const settings = readFileSync(join(ROOT, 'src/components/SettingsPage.ts'), 'utf8');
    assert.ok(!/current_password\s*:/.test(settings), 'settings must prove the password with SRP, not send it');
    assert.ok(!/new_password\s*:/.test(settings), 'a new password only travels as a verifier');

    const users = readFileSync(join(ROOT, 'functions/api/routes/users.ts'), 'utf8');
    assert.ok(!/current_password\s*:/.test(users), 'the server must not accept a plaintext current password');
    assert.ok(!/new_password\s*:/.test(users), 'the server must not accept a plaintext new password');
  });

  it('registration is SRP-only and the legacy login carries its removal condition', () => {
    const auth = readFileSync(join(ROOT, 'functions/api/routes/auth.ts'), 'utf8');
    assert.ok(auth.includes('SRP verifier required'), 'plaintext registration must be rejected');
    assert.ok(auth.includes('CUTOFF: delete this route'), 'legacy /login must document when it dies');

    const admin = readFileSync(join(ROOT, 'functions/api/routes/admin.ts'), 'utf8');
    assert.ok(admin.includes('cutoff_reached'), 'the removal condition must be measurable, not folklore');
  });

  it('the server never derives or opens vault key material', () => {
    const offenders = walk(join(ROOT, 'functions'))
      .filter((file) =>
        /deriveVaultKe|unlockVaultWith|unwrapSecret|decryptVaultItem|wrapVaultKey/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(ROOT, file));
    assert.deepEqual(offenders, [], `vault cryptography must stay client-side: ${offenders.join(', ')}`);

    const vault = readFileSync(join(ROOT, 'functions/api/routes/vault.ts'), 'utf8');
    assert.ok(!/password\s*:/.test(vault), 'vault routes must never read a password field');
    assert.ok(vault.includes('isValidVaultKdfParams'), 'opaque values must still be shape-checked');
  });

  it('the threat model states its invariants', () => {
    const spec = readFileSync(join(ROOT, 'docs/e2ee.md'), 'utf8');
    for (const invariant of ['server must never receive', 'No server-side escrow', 'allow-same-origin']) {
      assert.ok(spec.includes(invariant), `docs/e2ee.md must state: ${invariant}`);
    }
  });
});
