import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

mkdirSync('android-gui-artifacts', { recursive: true });
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim();
const app = 'app.flaxia.app';
const start = () => console.log(adb('shell', 'am', 'start', '-W', '-n', app + '/.MainActivity'));
async function connect() {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const pid = adb('shell', 'pidof', app).split(' ')[0];
      if (pid) {
        adb('forward', 'tcp:9222', 'localabstract:webview_devtools_remote_' + pid);
        const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
        const page = browser.contexts()[0].pages()[0];
        if (page) return { browser, page };
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
try {
  adb('install', '-r', 'android/app/build/outputs/apk/debug/app-debug.apk');
  start();
  current = await connect();
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
  await current.page.waitForFunction(() => navigator.onLine, { timeout: 60000 });
  await current.browser.close();
  current = undefined;
  execFileSync('node', ['--experimental-strip-types', '--test', 'tests/offline-games.browser.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANDROID_CDP: 'http://127.0.0.1:9222',
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
} finally {
  if (current) {
    await current.page.screenshot({ path: 'android-gui-artifacts/last-state.png' }).catch(() => {});
    await current.browser.close().catch(() => {});
  }
  adb('shell', 'svc', 'wifi', 'enable');
  adb('shell', 'svc', 'data', 'enable');
  writeFileSync('android-gui-artifacts/logcat.txt', adb('logcat', '-d'));
  writeFileSync('android-gui-artifacts/native-screen.png', execFileSync('adb', ['exec-out', 'screencap', '-p']));
}
