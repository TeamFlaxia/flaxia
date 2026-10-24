import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

test('downloaded game survives reload, plays with no network and keeps an isolated save', {
  timeout: 90000,
}, async (t) => {
  const android = Boolean(process.env.ANDROID_CDP);
  let url;
  if (!android) {
    const server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/api/wvfs-zip/offline-modules') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<html><body>Online module game fallback</body></html>');
        return;
      }
      if (!/^\/[A-Za-z0-9_.\/-]+$/.test(path) || path.includes('..')) {
        response.writeHead(404).end();
        return;
      }
      try {
        const bytes = await readFile(new URL('../dist' + path, import.meta.url));
        response.setHeader(
          'Content-Type',
          path.endsWith('.js') ? 'text/javascript' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream',
        );
        response.end(bytes);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    url = `http://127.0.0.1:${server.address().port}/__native-game-test.html`;
  }
  const browser = android
    ? await chromium.connectOverCDP(process.env.ANDROID_CDP, { noDefaults: true })
    : await chromium.launch({
        headless: true,
        executablePath: process.env.LOADER_CHROMIUM_EXECUTABLE,
        args: ['--no-sandbox'],
      });
  t.after(() => browser.close());
  const context = android ? browser.contexts()[0] : await browser.newContext();
  const page = android ? context.pages()[0] : await context.newPage();
  if (android) url = new URL('/__native-game-test.html', page.url()).href;
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.nativeGameHarness));
  assert.equal(await page.evaluate(() => window.nativeGameHarness.prepare()), 'saved');
  await page.reload();
  await page.waitForFunction(() => Boolean(window.nativeGameHarness));
  // The native test also blocks real connectivity before this phase in its runner.
  if (!android) await context.setOffline(true);
  else {
    execFileSync('adb', ['shell', 'svc', 'wifi', 'disable']);
    execFileSync('adb', ['shell', 'svc', 'data', 'disable']);
  }
  const result = await page.evaluate(() => window.nativeGameHarness.play());
  assert.deepEqual(result, { played: true, networkRequests: 0, saved: 1 });
  const game = page.frameLocator('iframe');
  await game.locator('#result').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('iframe') !== null);
  await game.locator('#result').filter({ hasText: '42' }).waitFor();
  assert.deepEqual(JSON.parse(await game.locator('#result').innerText()), {
    parentBlocked: true,
    bridgeBlocked: true,
    asset: 42,
  });
  await game.locator('#counter').click();
  await game.locator('#counter').click();
  assert.equal(await game.locator('#counter').innerText(), '2');
  await page.waitForFunction(() =>
    localStorage.getItem('flaxia:offline-game:smoke-user:offline-fixture')?.includes('2'),
  );
  await page.screenshot({ path: process.env.OFFLINE_GAME_SCREENSHOT ?? 'offline-game-test.png' });
  if (!android) await context.setOffline(false);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.nativeGameHarness));
  if (!android) await context.setOffline(true);
  assert.equal((await page.evaluate(() => window.nativeGameHarness.play())).played, true);
  assert.equal(await game.locator('#counter').innerText(), '2');
  if (!android) {
    await context.setOffline(false);
    assert.equal(await page.evaluate(() => window.nativeGameHarness.prepareUnsupported()), 'saved');
    assert.deepEqual(await page.evaluate(() => window.nativeGameHarness.launchUnsupported(true)), {
      played: true,
      error: '',
    });
    await page.frameLocator('iframe').getByText('Online module game fallback').waitFor();
    await context.setOffline(true);
    const offline = await page.evaluate(() => window.nativeGameHarness.launchUnsupported(false));
    assert.equal(offline.played, false);
    assert.match(offline.error, /offline_games.unsupported/);
    assert.equal(await page.locator('iframe').count(), 0);
  }
});
