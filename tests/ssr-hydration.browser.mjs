// Real-browser regression check for the SSR -> interactive handover.
// Universal +page.ts loads are re-run by SvelteKit during hydration; a
// `browser` branch used to replace the serialized SSR data with empty data, so
// the feed flashed empty. This test asserts the first HTML has real content and
// that the interactive UI takes over without losing it.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { seedUserAndLogin } from './helpers/setup.ts';

const playwrightModule =
  process.env.PLAYWRIGHT_MODULE || '/home/waipu/flaxian/flaxia-studio/node_modules/playwright/index.mjs';
const chromiumExecutable =
  process.env.CHROMIUM_EXECUTABLE || join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const baseUrl = process.env.FLAXIA_SSR_URL || 'http://localhost:8788';

test('SSR content is present before JS and survives the handover to the interactive feed', async (t) => {
  try {
    const probe = await fetch(`${baseUrl}/home`, { signal: AbortSignal.timeout(3000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (error) {
    t.skip(`SSR test server is unreachable at ${baseUrl}: ${error.message}`);
    return;
  }

  // Fresh CI databases are empty. seedUserAndLogin registers/logs in through
  // SRP (the helper targets the default dev:test origin localhost:8788).
  const suffix = crypto.randomUUID();
  const user = await seedUserAndLogin(suffix);
  const text = `hydration probe ${suffix}`;
  const postId = crypto.randomUUID();
  const created = await fetch(`${baseUrl}/api/posts/commit`, {
    method: 'POST',
    headers: { Cookie: user.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ postId, text, hashtags: [] }),
  });
  assert.equal(created.status, 200, `seeding a probe post failed: ${await created.text()}`);

  const ssrHtml = await (await fetch(`${baseUrl}/home`)).text();
  assert.ok(ssrHtml.includes(text), 'SSR HTML must contain the seeded post text before hydration');

  const { chromium } = await import(playwrightModule);
  const browser = await chromium.launch({
    executablePath: existsSync(chromiumExecutable) ? chromiumExecutable : undefined,
    headless: true,
    args: ['--no-sandbox'],
  });

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
