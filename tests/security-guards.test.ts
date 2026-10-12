import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import testsRouter from '../functions/api/routes/tests.ts';
import { renderJsonLd } from '../src/lib/render-html.ts';

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
 * Source with comment-only lines removed, rejoined as one string.
 *
 * Dropping whole-line comments (`//` or block-comment `*` bodies) keeps prose
 * that quotes the banned token from tripping a guard; matching the rejoined
 * text (instead of each line separately) keeps violations that span lines —
 * an attribute opened on one line with the banned token on the next is still
 * one match, since `\s*` spans newlines. Inline trailing comments on real
 * statements stay in: a naive full-comment strip would truncate a line at a
 * `//` inside a string literal and could hide a real violation.
 */
function scanableSource(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
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
      .filter((file) => pattern.test(scanableSource(readFileSync(file, 'utf8'))))
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

  it('keeps untrusted sandbox content off the authenticated API trust boundary', () => {
    // Every ZIP iframe is untrusted. The shared helper must always apply a
    // sandbox so a caller cannot accidentally opt out (the WVFS path did).
    const zipUi = readFileSync(join(ROOT, 'src/lib/zip-ui-utils.ts'), 'utf8');
    const zipSandbox = zipUi.match(/const ZIP_SANDBOX = ['"]([^'"]+)['"]/)?.[1] ?? '';
    assert.ok(zipSandbox, 'ZIP iframe helper must define a sandbox policy');
    assert.ok(zipSandbox.includes('allow-scripts'), 'ZIP games need scripts enabled');
    assert.ok(!zipSandbox.includes('allow-same-origin'), 'ZIP iframe sandbox must keep an opaque origin');
    assert.match(zipUi, /iframe\.sandbox = ZIP_SANDBOX/, 'ZIP iframe helper must always set the sandbox attribute');
    assert.ok(!/options:\s*\{[^}]*sandbox\?/.test(zipUi), 'callers must not be able to disable ZIP sandboxing');

    // iframe sandboxing does not protect users who open a sandbox URL directly.
    // The response CSP must force the same opaque-origin boundary even when the
    // untrusted document is the top-level page.
    const worker = readFileSync(join(ROOT, 'src/sandbox-worker.ts'), 'utf8');
    const sandboxCsp = worker.match(/const SANDBOX_CSP = \[([\s\S]*?)\]\.join\('; '\);/)?.[1] ?? '';
    assert.ok(sandboxCsp, 'sandbox worker must define SANDBOX_CSP');
    assert.match(sandboxCsp, /sandbox allow-scripts/, 'sandbox worker CSP must force sandboxing');
    assert.ok(!sandboxCsp.includes('allow-same-origin'), 'sandbox worker CSP must force an opaque origin');

    // User-controlled sandbox code communicates with the app through typed
    // postMessage bridges. It must never be a credentialed CORS or CSRF origin.
    const api = readFileSync(join(ROOT, 'functions/api/[[route]].ts'), 'utf8');
    const helpers = readFileSync(join(ROOT, 'functions/api/helpers.ts'), 'utf8');
    assert.ok(api.includes('allowedOrigins.has(origin)'), 'API CORS must use the shared origin allowlist');
    assert.ok(
      helpers.includes('export const allowedOrigins = new Set('),
      'CSRF must define the shared origin allowlist',
    );
    assert.ok(!helpers.includes('SANDBOX_ORIGIN'), 'sandbox origin must not receive credentialed CORS');
    assert.ok(!helpers.includes('sandbox.flaxia.app'), 'sandbox origin must not bypass CSRF validation');
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
      'auth:verification-resend:ip',
      'auth:verification-resend:email',
      'auth:verification-resend:cooldown',
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

  it('does not log session tokens, signed requests, or push response bodies', () => {
    const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
    assert.ok(!main.includes("console.log('[push] connecting to', url)"));
    assert.ok(!main.includes("console.log('[push] received:', data)"));
    assert.doesNotMatch(main, /console\.(?:log|info|warn|error)\([^\n]*window\.location\.href/);

    const signature = readFileSync(join(ROOT, 'functions/lib/activitypub/signature.ts'), 'utf8');
    const requestSigner = signature.match(
      /export async function signRequest\([\s\S]*?export async function signedFetch/,
    );
    assert.ok(requestSigner, 'ActivityPub request signer must be discoverable');
    assert.doesNotMatch(requestSigner[0], /console\.(?:log|info|warn|error)\(/);

    const delivery = readFileSync(join(ROOT, 'functions/queue-worker.ts'), 'utf8');
    assert.ok(!delivery.includes("console.log('Headers:', Object.fromEntries(headers.entries()))"));
    assert.ok(!delivery.includes("console.log('Accept activity:', JSON.stringify(acceptActivity"));
    assert.ok(!delivery.includes('const responseText = await response.text()'));

    const activityPubCrypto = readFileSync(join(ROOT, 'functions/lib/activitypub/crypto.ts'), 'utf8');
    assert.doesNotMatch(activityPubCrypto, /console\.(?:log|info|warn|error)\([^\n]*(?:private key|pemContents)/i);

    for (const file of ['src/components/PostComposer.ts', 'src/components/ReplyComposer.ts']) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      assert.doesNotMatch(
        source,
        /console\.(?:log|info|warn|error)\([^\n]*(?:uploadUrl|responseText)/,
        `${file} must not log private upload paths or response bodies`,
      );
    }

    for (const file of ['functions/lib/fcm.ts', 'functions/lib/push.ts']) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      assert.ok(!source.includes('await res.text()'), `${file} must not log provider response bodies`);
    }
  });

  it('authenticates orchestrator callbacks', () => {
    // /api/crowd/webhook is a standalone Pages Function: no Hono middleware,
    // no session, no CSRF. An unsigned callback could post an `infected`
    // verdict for any public media key and blocklist it permanently.
    const crowd = readFileSync(join(ROOT, 'functions/lib/crowd.ts'), 'utf8');
    assert.ok(crowd.includes('verifyCallbackSignature'), 'the webhook must verify the callback signature');
    assert.match(
      crowd,
      /if \(!\(await verifyCallbackSignature\(url, crowdConfig\(env\)\)\)\)/,
      'the signature must be checked before the payload is parsed',
    );

    // Every URL handed to the orchestrator must go through the signer.
    for (const file of ['functions/lib/crowd.ts', 'functions/lib/scan/clamav.ts']) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      assert.ok(
        !/callbackUrl:\s*buildCallbackUrl\(/.test(src),
        `${file} hands the orchestrator an unsigned callback URL`,
      );
      assert.ok(src.includes('signedCallbackUrl'), `${file} must sign its callback URLs`);
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

  it('every route that writes to R2 runs the file scan pipeline', () => {
    const routesDir = join(ROOT, 'functions/api/routes');
    const offenders: string[] = [];
    for (const file of readdirSync(routesDir)) {
      if (!file.endsWith('.ts')) continue;
      const src = readFileSync(join(routesDir, file), 'utf8');
      if (!src.includes('BUCKET.put')) continue;
      if (!src.includes('scanUploadSync')) {
        offenders.push(file);
        continue;
      }
      // A sink that scans must also hand the bytes to ClamAV afterwards.
      assert.ok(
        src.includes('submitFileScans'),
        `${file} writes to R2 and scans synchronously but never submits the async ClamAV scan`,
      );
    }
    assert.deepEqual(offenders, [], `upload sinks must run scanUploadSync: ${offenders.join(', ')}`);
  });

  it("keeps KV expiration TTLs at or above Cloudflare's 60 second floor", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'functions'))) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(/expirationTtl:\s*(\d+)/g)) {
        if (Number(match[1]) < 60) offenders.push(`${relative(ROOT, file)}:${match[1]}`);
      }
      for (const match of src.matchAll(/kvCacheSet\([^;]+,\s*(\d+)\s*\)/g)) {
        if (Number(match[1]) < 60) offenders.push(`${relative(ROOT, file)}:${match[1]}`);
      }
    }
    assert.deepEqual(offenders, [], `KV expirationTtl must be >= 60: ${offenders.join(', ')}`);
  });

  it('queries chronological timelines fresh with user-specific filters', () => {
    const src = readFileSync(join(ROOT, 'functions/api/routes/posts.ts'), 'utf8');
    const handler = src.match(/posts\.get\('\/posts',[\s\S]*?(?=\/\/ GET \/api\/posts\/trending)/)?.[0] ?? '';
    assert.ok(handler, 'chronological timeline handler must be discoverable');
    assert.ok(handler.includes('follower_id = ?'), 'Following must bind the authenticated follower id');
    assert.ok(handler.includes('WHERE p.username = ?'), 'profile timelines must bind the requested username');
    assert.doesNotMatch(handler, /kvCache(?:Get|Set)\(/, 'chronological posts must not come from a stale KV snapshot');
  });

  it('escapes JSON-LD embedded in SSR pages', () => {
    const html = renderJsonLd({ name: '</script><script>alert(1)</script>', sep: '\u2028' });
    assert.ok(!html.includes('</script><script>'), 'JSON-LD values must not close the script element');
    assert.ok(html.includes('\\u003c'), '`<` must be escaped');
    assert.ok(html.includes('\\u2028'), 'U+2028 must be escaped');
  });

  it('keeps the SSRF guard on user-controlled outbound fetches', () => {
    const linkPreview = readFileSync(join(ROOT, 'functions/api/routes/link-preview.ts'), 'utf8');
    assert.ok(linkPreview.includes('fetchWithSsrfGuard'));
    assert.ok(!linkPreview.includes("redirect: 'follow'"), 'redirects must be validated hop by hop');

    const users = readFileSync(join(ROOT, 'functions/api/routes/users.ts'), 'utf8');
    assert.ok(users.includes('fetchRemoteJson'), 'webfinger/actor fetches must use the guard');

    const queue = readFileSync(join(ROOT, 'functions/queue-worker.ts'), 'utf8');
    assert.ok(queue.includes('parsePublicHttpUrl'), 'delivery inboxes must be re-validated');

    const activitypub = readFileSync(join(ROOT, 'functions/api/routes/activitypub.ts'), 'utf8');
    assert.ok(activitypub.includes('localActorUsername'), 'shared inbox targets need canonical origin checks');
  });

  it('never lets a single report hide a post', () => {
    const helpers = readFileSync(join(ROOT, 'functions/api/helpers.ts'), 'utf8');
    const block = helpers.match(/const thresholds: Record<ReportCategory, number> = \{([\s\S]*?)\};/)?.[1] ?? '';
    assert.ok(block, 'report thresholds must be discoverable');
    for (const line of block.split('\n')) {
      const value = line.match(/:\s*(\d+),/)?.[1];
      if (value) assert.ok(Number(value) >= 2, `single-report hide is not allowed: ${line.trim()}`);
    }
    const report = readFileSync(join(ROOT, 'functions/api/routes/report.ts'), 'utf8');
    assert.ok(!/Immediate hide - no threshold check/.test(report), 'csam/malware must not hide on one report');
    assert.ok(report.includes('checkRateLimit'), 'reports must be rate limited');
  });

  it('serves only real audio/video from the media proxies', () => {
    const media = readFileSync(join(ROOT, 'functions/api/routes/media.ts'), 'utf8');
    assert.ok(media.includes('safeMediaContentType'), 'media proxies must class-check the stored type');
    assert.ok(media.includes("safeMediaContentType(key, object.httpMetadata?.contentType, 'audio')"));
    assert.ok(media.includes("safeMediaContentType(key, object.httpMetadata?.contentType, 'video')"));
  });

  it('checks session expiry in the market checkout', () => {
    const checkout = readFileSync(join(ROOT, 'functions/api/market/checkout.ts'), 'utf8');
    assert.ok(checkout.includes('expires_at > strftime'), 'checkout must not accept expired sessions');
    assert.ok(checkout.includes('isAllowedOrigin'), 'checkout must enforce an origin allowlist');
  });

  it('validates client-supplied media keys against the caller', () => {
    const posts = readFileSync(join(ROOT, 'functions/api/routes/posts.ts'), 'utf8');
    assert.ok(posts.includes('isOwnedMediaKey'), 'media keys must be ownership-checked');
    assert.ok(
      !/BUCKET\.delete\(k\)/.test(posts) || posts.includes('isOwnedMediaKey'),
      'R2 cleanup must only run for owned keys',
    );
  });

  it('caps ZIP inflation and enforces hidden-post media', () => {
    const wvfs = readFileSync(join(ROOT, 'src/lib/wvfs-zip-server.ts'), 'utf8');
    assert.ok(wvfs.includes('inflateSync(compressedData, { out:'), 'inflate output must be bounded');

    const media = readFileSync(join(ROOT, 'functions/api/routes/media.ts'), 'utf8');
    assert.ok(media.includes('postMediaAllowed'), 'zip/swf routes must respect hidden posts');
  });

  it('treats game containers as non-attachments', () => {
    const attachments = readFileSync(join(ROOT, 'functions/lib/attachments.ts'), 'utf8');
    assert.ok(attachments.includes('GAME_EXTS'), 'zip/swf/html must not become attachments');
    assert.match(attachments, /GAME_EXTS\.has\(ext\)\) return null/);
  });

  it('fails crowd callbacks closed outside local dev', () => {
    const crowd = readFileSync(join(ROOT, 'functions/lib/crowd.ts'), 'utf8');
    assert.ok(crowd.includes('allowUnsignedCallbacks'), 'unsigned callbacks must be gated');
    assert.ok(
      !/if \(!config\.webhookSecret\) return true;/.test(crowd),
      'an unconfigured production webhook must reject unsigned callbacks',
    );
  });

  it('validates recovery phrases with the BIP-39 checksum', () => {
    const primitives = readFileSync(join(ROOT, 'src/lib/vault/primitives.ts'), 'utf8');
    assert.ok(primitives.includes('validateMnemonic'), 'recovery phrases must carry a valid checksum');
  });

  it('does not read the games cache for cursor pages', () => {
    const games = readFileSync(join(ROOT, 'functions/api/routes/games.ts'), 'utf8');
    const cacheGuard = games.indexOf('if (!shuffle && !cursor) {');
    const cacheRead = games.indexOf('cachedData = await c.env.CACHE?.get(cacheKey);');
    assert.ok(cacheGuard !== -1, 'games cache reads must be limited to first pages');
    assert.ok(cacheRead > cacheGuard, 'cursor pages must not enter the games cache-read path');
  });

  it('drops arcade events for unknown games and keeps media cache short', () => {
    const games = readFileSync(join(ROOT, 'functions/api/routes/games.ts'), 'utf8');
    assert.ok(games.includes('loadValidGamePostIds'), 'arcade events must target published games');
    const media = readFileSync(join(ROOT, 'functions/api/routes/media.ts'), 'utf8');
    assert.ok(!media.includes('31536000'), 'media must not be cached for a year before scan verdicts land');
    assert.ok(media.includes('postKeyMediaAllowed'), 'key-addressed media must respect hidden posts');
  });
});
