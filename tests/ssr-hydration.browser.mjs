// Real-browser regression check for the SSR -> interactive handover.
// Universal +page.ts loads are re-run by SvelteKit during hydration; a
// `browser` branch used to replace the serialized SSR data with empty data, so
// the feed flashed empty. This test asserts the first HTML has real content and
// that the interactive UI takes over without losing it.
//
// Everything here is relative to FLAXIA_SSR_URL: the test must work from a
// checkout on any machine, not just the original author's home directory.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
// Only override the browser binary when explicitly asked. Otherwise Playwright
// uses its own installed Chromium (or the configured channel).
const chromiumExecutable = process.env.CHROMIUM_EXECUTABLE || null;
const baseUrl = process.env.FLAXIA_SSR_URL || 'http://localhost:8788';
const requireServer = process.env.FLAXIA_SSR_REQUIRE_SERVER === '1';

test('browser harness is portable', async () => {
  assert.equal(playwrightModule, process.env.PLAYWRIGHT_MODULE || 'playwright');
  assert.equal(chromiumExecutable, process.env.CHROMIUM_EXECUTABLE || null);
  assert.equal(baseUrl, process.env.FLAXIA_SSR_URL || 'http://localhost:8788');

  const source = await readFile(new URL('./ssr-hydration.browser.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/home\/waipu\//, 'no machine-specific paths');
  assert.doesNotMatch(source, /from ['"]\.\/helpers\/setup/, 'seeding must target the configured origin');
  assert.match(source, /FLAXIA_SSR_REQUIRE_SERVER/, 'a required server must fail loudly');
});

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function unb64(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function testUsername(suffix) {
  const sanitized = `testuser${suffix}`.replace(/[^a-zA-Z0-9_]/g, '');
  if (sanitized.length <= 20) return sanitized;
  let hash = 5381;
  for (let i = 0; i < suffix.length; i++) hash = ((hash << 5) + hash + suffix.charCodeAt(i)) >>> 0;
  return `${sanitized.slice(0, 12)}${hash.toString(36).slice(0, 7)}`;
}

/**
 * Register + SRP login + probe post, all against the configured origin.
 * Returns the session cookie pair and username so a browser context can be
 * signed in without a second login round-trip.
 */
async function seedProbePost(text) {
  const srp = await import('../src/lib/srp.ts');
  const suffix = crypto.randomUUID();
  const email = `user${suffix}@test.com`;
  const username = testUsername(suffix);
  const password = 'password123';
  const salt = srp.generateSalt();
  const verifier = await srp.computeVerifier(password, salt, srp.DEFAULT_SRP_KDF);

  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      username,
      display_name: `Test User ${suffix}`,
      srp_salt: b64(salt),
      srp_verifier: b64(verifier),
      srp_group: '2048',
      srp_kdf: srp.DEFAULT_SRP_KDF,
    }),
  });
  assert.ok(registered.ok, `seeding a user failed: ${await registered.text()}`);

  const start = await fetch(`${baseUrl}/api/auth/login/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const challenge = await start.json();
  assert.ok(challenge.srp && challenge.challenge_id, 'the test server must support SRP login');
  const { A, a } = await srp.clientStep1(password, unb64(challenge.salt));
  const kdf = srp.isSupportedSrpKdf(challenge.srp_kdf) ? challenge.srp_kdf : srp.DEFAULT_SRP_KDF;
  const finish = await srp.clientStep2(password, unb64(challenge.salt), a, unb64(challenge.B), kdf);
  const verified = await fetch(`${baseUrl}/api/auth/login/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, challenge_id: challenge.challenge_id, A: b64(A), M1: b64(finish.M1) }),
  });
  assert.ok(verified.ok, `login failed: ${await verified.text()}`);
  const proof = await verified.json().catch(() => ({}));
  if (proof.M2) {
    assert.ok(await srp.verifyServerProof(finish.A, finish.M1, finish.K, unb64(proof.M2)), 'server proof must verify');
  }
  const cookie = verified.headers.get('set-cookie') ?? '';
  assert.ok(cookie, 'login must issue a session cookie');

  const postId = crypto.randomUUID();
  const created = await fetch(`${baseUrl}/api/posts/commit`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId, text, hashtags: [] }),
  });
  assert.equal(created.status, 200, `seeding a probe post failed: ${await created.text()}`);
  return { cookie: cookie.split(';')[0].trim(), username };
}

test('SSR content is present before JS and survives the handover to the interactive feed', async (t) => {
  try {
    const probe = await fetch(`${baseUrl}/home`, { signal: AbortSignal.timeout(3000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (error) {
    if (requireServer) throw new Error(`SSR test server is unreachable at ${baseUrl}: ${error.message}`);
    t.skip(`SSR test server is unreachable at ${baseUrl}: ${error.message}`);
    return;
  }

  // Fresh CI databases are empty, so seed through the configured origin.
  const suffix = crypto.randomUUID();
  const text = `hydration probe ${suffix}`;
  await seedProbePost(text);

  const ssrHtml = await (await fetch(`${baseUrl}/home`)).text();
  assert.ok(ssrHtml.includes(text), 'SSR HTML must contain the seeded post text before hydration');

  const { chromium } = await import(playwrightModule);
  const launchOptions = { headless: true, args: ['--no-sandbox'] };
  if (chromiumExecutable) launchOptions.executablePath = chromiumExecutable;
  const browser = await chromium.launch(launchOptions);

  try {
    const page = await browser.newPage();
    /** @type {string[]} */
    const consoleMessages = [];
    /** @type {string[]} */
    const pageErrors = [];
    page.on('console', (message) => consoleMessages.push(message.text()));
    page.on('pageerror', (error) => pageErrors.push(error.message));

    // Delay the client entry chunks so the pre-hydration DOM is observable.
    const slowChunk = async (/** @type {any} */ route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    };
    await page.route('**/_app/immutable/entry/*.js', slowChunk);
    await page.route('**/_app/immutable/nodes/*.js', slowChunk);

    const response = await page.goto(`${baseUrl}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assert.equal(response?.status(), 200, 'home must render successfully');

    const ssrFeed = page.locator('.ssr-feed');
    await ssrFeed.waitFor({ state: 'visible', timeout: 10000 });
    assert.ok((await ssrFeed.innerText()).includes(text), 'the SSR feed must show the seeded post before JS boots');

    // Once the interactive Timeline has data it hands over and removes the
    // SSR-only section. The post must remain visible - no empty-feed flash.
    await page.waitForFunction(
      (postText) => !document.querySelector('.ssr-feed') && document.body.innerText.includes(postText),
      text,
      { timeout: 20000 },
    );

    assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
    const mismatch = consoleMessages.find((message) => /hydration_mismatch/i.test(message));
    assert.equal(mismatch, undefined, `hydration must not warn about mismatches: ${mismatch ?? ''}`);
  } finally {
    await browser.close();
  }
});

test('SSR boot data removes the locale/session network gate during hydration', async (t) => {
  try {
    const probe = await fetch(`${baseUrl}/home`, { signal: AbortSignal.timeout(3000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (error) {
    if (requireServer) throw new Error(`SSR test server is unreachable at ${baseUrl}: ${error.message}`);
    t.skip(`SSR test server is unreachable at ${baseUrl}: ${error.message}`);
    return;
  }

  // A real SRP session and a probe post: the boot payload must describe this
  // signed-in user, and the interactive feed must have a card to click.
  const suffix = crypto.randomUUID();
  const text = `boot data probe ${suffix}`;
  const { cookie, username } = await seedProbePost(text);
  const budgetMs = 1500;

  // 1. The first HTML carries an inert boot block with the SSR locale/session.
  const ssrHtml = await (
    await fetch(`${baseUrl}/home`, {
      headers: { Accept: 'text/html', Cookie: `flaxia_locale=ja; ${cookie}` },
    })
  ).text();
  assert.match(ssrHtml, /id=["']__flaxia_boot__["']/, 'SSR HTML must contain the boot data block');
  const bootTag = ssrHtml.match(/<script\b[^>]*\bid=["']__flaxia_boot__["'][^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(bootTag, 'the boot block must be an inert JSON script');
  const boot = JSON.parse(bootTag[1]);
  // The hook inlines the locale bundle as `{ locale, strings }` (older/other
  // transports may use a bare locale string - accept both).
  const bootLocale = typeof boot.locale === 'string' ? boot.locale : boot.locale?.locale;
  assert.equal(bootLocale, 'ja', 'boot data must carry the cookie locale');
  const bootUsername = boot.session?.username ?? boot.session?.user?.username;
  assert.equal(bootUsername, username, 'boot data must carry the signed-in user');

  // Translation keys belong in the boot block, not in the rendered text.
  const renderedText = ssrHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  assert.ok(renderedText.includes(text), 'the probe post must be in the SSR body');
  assert.doesNotMatch(
    renderedText,
    /\b(?:nav|site|post|command|settings)\.[a-z_]+/i,
    'SSR body text must be translated, not raw i18n keys',
  );

  const { chromium } = await import(playwrightModule);
  const launchOptions = { headless: true, args: ['--no-sandbox'] };
  if (chromiumExecutable) launchOptions.executablePath = chromiumExecutable;
  const browser = await chromium.launch(launchOptions);

  try {
    const context = await browser.newContext();
    const [cookieName, ...cookieValue] = cookie.split('=');
    await context.addCookies([
      { name: 'flaxia_locale', value: 'ja', url: baseUrl },
      { name: cookieName, value: cookieValue.join('='), url: baseUrl },
    ]);
    const page = await context.newPage();
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    // Same user shape as tests/app-shell.browser.mjs SIGNED_IN_STUBS, but the
    // response only arrives after 5s so a client that waits for it fails.
    const signedInMe = { user: { id: 'u1', username, display_name: 'Mikan', language: 'ja' } };
    await page.route('**/locales/*.json', async (/** @type {any} */ route) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await route.continue().catch(() => {});
    });
    await page.route('**/api/me', async (/** @type {any} */ route) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await route
        .fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(signedInMe) })
        .catch(() => {});
    });

    const response = await page.goto(`${baseUrl}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    assert.equal(response?.status(), 200, 'home must render successfully');

    const globals = await page.evaluate(() => ({
      boot: globalThis.__FLAXIA_BOOT__,
      locale: globalThis.__FLAXIA_LOCALE__,
      username: globalThis.__FLAXIA_SESSION__?.username ?? globalThis.__FLAXIA_SESSION__?.user?.username,
    }));
    assert.equal(globals.boot, true, 'the static reader must mark the page as boot-bearing');
    const globalLocale = typeof globals.locale === 'string' ? globals.locale : globals.locale?.locale;
    assert.equal(globalLocale, 'ja', 'the static reader must publish the boot locale');
    assert.equal(globals.username, username, 'the static reader must publish the boot session');

    // 3. The SSR section hands over without waiting for the stalled endpoints.
    // Both timestamps use the browser clock: entry responseEnd is when JS lands,
    // performance.now() is when the interactive feed has taken over.
    const handover = await page
      .waitForFunction(
        (postText) => {
          if (document.querySelector('.ssr-feed') || !document.body.innerText.includes(postText)) return false;
          const entries = performance
            .getEntriesByType('resource')
            .filter((entry) => entry.name.includes('/_app/immutable/entry/') && entry.name.endsWith('.js'));
          return {
            at: performance.now(),
            jsAt: entries.length ? Math.max(...entries.map((entry) => entry.responseEnd)) : 0,
          };
        },
        text,
        { timeout: 30000 },
      )
      .then((handle) => handle.jsonValue());
    assert.ok(handover.jsAt > 0, 'the browser must load the SvelteKit entry chunk');
    assert.ok(
      handover.at - handover.jsAt <= budgetMs,
      `handover happened ${Math.round(handover.at - handover.jsAt)}ms after JS loaded (budget ${budgetMs}ms)`,
    );

    // 4. Signed-in UI, not the guest shell (selectors from app-shell.browser.mjs).
    await page.waitForSelector('.nav-user-area', { timeout: budgetMs });
    assert.ok(await page.$('.nav-post-button'), 'compose button must render for the boot session');
    assert.equal(await page.$('.nav-auth-buttons'), null, 'guest auth buttons must not render');
    assert.equal(await page.$('.nav-promo'), null, 'guest promo must not render');

    // A real post card click reaches the thread inside the same short budget.
    const clickedAt = Date.now();
    await page.locator('.post-card .post-text').first().click();
    await page.waitForURL(/\/thread\//, { timeout: budgetMs * 2 });
    const clickMs = Date.now() - clickedAt;
    assert.ok(clickMs <= budgetMs, `post card click took ${clickMs}ms (budget ${budgetMs}ms)`);

    assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
  } finally {
    await browser.close();
  }
});
