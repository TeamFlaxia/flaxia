import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

mkdirSync('android-gui-artifacts', { recursive: true });
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const app = 'app.flaxia.app';
const start = () => console.log(adb('shell', 'am', 'start', '-W', '-n', app + '/.MainActivity'));
async function connect() {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const pid = adb('shell', 'pidof', app).split(' ')[0];
      if (pid) {
        adb('forward', 'tcp:9222', 'localabstract:webview_devtools_remote_' + pid);
        // Android WebView exposes this socket but does not advertise it through
        // /json/version. Use the same endpoint as Playwright's Android adapter.
        const browser = await chromium.connectOverCDP('ws://127.0.0.1:9222/devtools/browser', { noDefaults: true });
        const page = browser.contexts()[0].pages()[0];
        if (page) {
          page.on('pageerror', (error) => console.log('App error:', String(error)));
          page.on('console', (message) => {
            if (message.type() === 'error') console.log('App console:', message.text().slice(0, 1000));
          });
          return { browser, page };
        }
        await browser.close();
      }
    } catch (error) {
      lastError = error;
      if (attempt % 10 === 0) console.log('WebView connection:', String(error));
      /* the WebView is still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(
    'Processes:',
    adb('shell', 'ps', '-A')
      .split('\n')
      .filter((line) => line.includes('flaxia'))
      .join('\n'),
  );
  console.log(
    'Debug sockets:',
    adb('shell', 'cat', '/proc/net/unix')
      .split('\n')
      .filter((line) => line.includes('devtools'))
      .join('\n'),
  );
  throw new Error('Android WebView debugger did not start: ' + String(lastError));
}
let current;
async function waitForNetwork(page) {
  let last;
  for (let attempt = 0; attempt < 15; attempt++) {
    last = await page.evaluate(async () => {
      try {
        return await Promise.race([
          window.Capacitor.nativePromise('CapacitorHttp', 'request', {
            url: 'https://flaxia.app/api/posts?limit=1',
            method: 'GET',
            responseType: 'json',
            headers: { Accept: 'application/json' },
            connectTimeout: 5000,
            readTimeout: 5000,
          }).then((response) => ({
            status: response.status,
            posts: Array.isArray(response.data?.posts),
            text: JSON.stringify(response.data).slice(0, 300),
          })),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 7000)),
        ]);
      } catch (error) {
        return { error: String(error) };
      }
    });
    console.log('Device API readiness:', JSON.stringify(last));
    if (last.status === 200 && last.posts) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Device cannot reach the production API: ' + JSON.stringify(last));
}
try {
  adb('install', '-r', 'android/app/build/outputs/apk/debug/app-debug.apk');
  adb('shell', 'svc', 'wifi', 'enable');
  adb('shell', 'svc', 'data', 'enable');
  start();
  current = await connect();
  await waitForNetwork(current.page);
  await current.page.evaluate(() => localStorage.setItem('flaxia_locale', 'ja'));
  await current.page.reload();
  await current.page.locator('.timeline').waitFor({ timeout: 60000 });
  console.log(
    'API probe:',
    JSON.stringify(
      await current.page.evaluate(async () => {
        const result = [];
        for (const path of ['/api/me', '/api/posts?limit=20', '/api/posts/recommended?limit=20']) {
          try {
            result.push(
              await Promise.race([
                (async () => {
                  const response = await fetch(path);
                  return { path, status: response.status, text: (await response.text()).slice(0, 500) };
                })(),
                new Promise((resolve) => setTimeout(() => resolve({ path, timeout: true }), 12000)),
              ]),
            );
          } catch (error) {
            result.push({ path, error: String(error) });
          }
        }
        let direct;
        try {
          direct = await Promise.race([
            window.Capacitor.nativePromise('CapacitorHttp', 'request', {
              url: 'https://flaxia.app/api/posts?limit=1',
              method: 'GET',
              responseType: 'json',
              headers: { Accept: 'application/json' },
              connectTimeout: 5000,
              readTimeout: 5000,
            }).then((r) => ({ status: r.status, data: JSON.stringify(r.data).slice(0, 500) })),
            new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 12000)),
          ]);
        } catch (error) {
          direct = { error: String(error) };
        }
        return {
          url: location.href,
          online: navigator.onLine,
          platform: window.Capacitor?.getPlatform?.(),
          native: window.Capacitor?.isNativePlatform?.(),
          result,
          direct,
        };
      }),
    ),
  );
  await current.page.locator('.post-card').first().waitFor({ timeout: 90000 });
  const online = await current.page.locator('.post-card').count();
  await current.page.screenshot({ path: 'android-gui-artifacts/timeline-online.png' });
  await current.browser.close();
  adb('shell', 'svc', 'wifi', 'disable');
  adb('shell', 'svc', 'data', 'disable');
  adb('shell', 'am', 'force-stop', app);
  start();
  current = await connect();
  await current.page.locator('.post-card').first().waitFor({ timeout: 90000 });
  await current.page.locator('.offline-banner:not([hidden])').waitFor({ timeout: 90000 });
  const offline = await current.page.locator('.post-card').count();
  assert.ok(online > 0 && offline > 0);
  await current.page.screenshot({ path: 'android-gui-artifacts/timeline-offline-cold-start.png' });
  adb('shell', 'svc', 'wifi', 'enable');
  await current.page.waitForFunction(() => navigator.onLine, null, { timeout: 60000 });
  await current.browser.close();
  current = undefined;
  execFileSync('node', ['--experimental-strip-types', '--test', 'tests/offline-games.browser.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANDROID_CDP: 'ws://127.0.0.1:9222/devtools/browser',
      OFFLINE_GAME_SCREENSHOT: 'android-gui-artifacts/downloaded-game-offline.png',
    },
  });
  writeFileSync(
    'android-gui-artifacts/result.json',
    JSON.stringify(
      {
        onlinePosts: online,
        offlinePosts: offline,
        offlineNetwork: 'Android Wi-Fi and mobile data disabled',
        game: 'Test fixture ZIP through the real download/store/player code; mock account and publication descriptor',
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error('Android smoke failed:', error);
  if (current) {
    const state = await current.page
      .evaluate(() => ({
        url: location.href,
        text: document.body.innerText,
        native: Boolean(window.Capacitor),
        online: navigator.onLine,
      }))
      .catch(() => null);
    writeFileSync('android-gui-artifacts/failure.json', JSON.stringify(state, null, 2));
  }
  throw error;
} finally {
  if (current) {
    await current.page.screenshot({ path: 'android-gui-artifacts/last-state.png' }).catch(() => {});
    await current.browser.close().catch(() => {});
  }
  for (const service of ['wifi', 'data']) {
    try {
      adb('shell', 'svc', service, 'enable');
    } catch {
      /* retain primary failure */
    }
  }
  try {
    writeFileSync('android-gui-artifacts/logcat.txt', adb('logcat', '-d'));
  } catch (error) {
    writeFileSync('android-gui-artifacts/logcat.txt', error.stdout ?? String(error));
  }
  try {
    writeFileSync(
      'android-gui-artifacts/native-screen.png',
      execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 16 * 1024 * 1024 }),
    );
  } catch {
    /* retain primary failure */
  }
}
