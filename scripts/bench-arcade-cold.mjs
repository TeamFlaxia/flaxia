#!/usr/bin/env node
/**
 * Actual browser cold-load profiling against a public Arcade deployment.
 *
 * Usage:
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
 *   ARCADE_BENCH_URL=https://flaxia.app/arcade \
 *   ARCADE_BENCH_BROWSER=chromium node scripts/bench-arcade-cold.mjs
 *
 * Each trial gets a fresh non-persistent browser context with cache disabled.
 * This is a *browser-cold* run, not a guarantee of an empty Cloudflare edge
 * cache. The X-WVFS-Cache header reports the edge HIT/MISS if available.
 * iframe load is NOT proof that a game is interactable.
 */
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const engineName = process.env.ARCADE_BENCH_BROWSER ?? 'chromium';
const engine = { chromium, firefox }[engineName];
if (!engine) throw new Error(`Unsupported browser: ${engineName}`);

const target = process.env.ARCADE_BENCH_URL ?? 'https://flaxia.app/arcade';
const trials = Math.min(5, Math.max(1, Number(process.env.ARCADE_BENCH_TRIALS ?? 3)));
const directory = process.env.ARCADE_BENCH_OUTPUT ?? 'artifacts';
await mkdir(directory, { recursive: true });
const results = [];

const browser = await engine.launch({
  headless: true,
  ...(engine === chromium && process.env.LOADER_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.LOADER_CHROMIUM_EXECUTABLE }
    : {}),
  ...(engine === firefox
    ? {
        firefoxUserPrefs: {
          'browser.cache.disk.enable': false,
          'browser.cache.memory.enable': false,
          'browser.cache.offline.enable': false,
        },
      }
    : {}),
  args: engine === chromium ? ['--no-sandbox'] : [],
});
try {
  for (let trial = 0; trial < trials; trial++) {
    const context = await browser.newContext({
      extraHTTPHeaders: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    if (engine === chromium) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Performance.enable');
    }
    await context.addInitScript(() => {
      window.__arcadeColdPaints = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__arcadeColdPaints.push({ name: entry.name, startTime: entry.startTime });
          }
        }).observe({ type: 'paint', buffered: true });
      } catch {}
    });

    const requests = [];
    const pending = [];
    const failures = [];
    page.on('requestfailed', (request) => {
      failures.push({ url: request.url(), error: request.failure()?.errorText });
    });
    page.on('requestfinished', (request) => {
      pending.push(
        (async () => {
          const response = await request.response();
          const timing = request.timing();
          let sizes;
          try {
            sizes = await request.sizes();
          } catch {
            sizes = null;
          }
          requests.push({
            method: request.method(),
            type: request.resourceType(),
            url: request.url(),
            status: response?.status() ?? null,
            ttfbMs: timing.responseStart >= 0 ? Math.round(timing.responseStart) : null,
            downloadMs:
              timing.responseEnd >= 0 && timing.responseStart >= 0
                ? Math.round(timing.responseEnd - timing.responseStart)
                : null,
            elapsedMs: timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null,
            transferBytes: sizes?.responseBodySize ?? null,
            edgeCache: response?.headers()['x-wvfs-cache'] ?? null,
            browserServiceWorker: response?.fromServiceWorker() ?? false,
          });
        })().catch((error) => failures.push({ url: request.url(), error: String(error) })),
      );
    });

    const begun = Date.now();
    let firstIframeLoadMs = null;
    let iframeUrl = null;
    let pageMetrics = null;
    let error = null;
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const iframe = await page.waitForSelector('.arcade-game-area iframe', { timeout: 30000 });
      iframeUrl = await iframe.getAttribute('src');
      const frame = await iframe.contentFrame();
      if (!frame) throw new Error('Arcade iframe was detached');
      await frame.waitForLoadState('load', { timeout: 35000 });
      firstIframeLoadMs = Date.now() - begun;
      // Allow late assets to appear in the waterfall, without counting them
      // as a claim of the game's first interactive frame.
      await page.waitForTimeout(1200);
      pageMetrics = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0];
        return {
          domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
          mainLoadMs: navigation?.loadEventEnd ?? null,
          paints: window.__arcadeColdPaints ?? [],
        };
      });
    } catch (failure) {
      error = String(failure);
    }

    await Promise.allSettled(pending);
    const resources = requests.filter((request) => request.url.includes('/api/wvfs-zip/'));
    const result = {
      browser: engineName,
      browserVersion: browser.version(),
      trial: trial + 1,
      target,
      cacheMode: 'fresh context, browser cache disabled; edge cache not purged',
      iframeUrl,
      firstIframeLoadMs,
      pageMetrics,
      counts: {
        total: requests.length,
        wvfsHead: resources.filter((r) => r.method === 'HEAD').length,
        wvfsGet: resources.filter((r) => r.method === 'GET').length,
        failed: failures.length,
      },
      transferBytes: requests.reduce((sum, item) => sum + (item.transferBytes ?? 0), 0),
      requests: requests.sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0)),
      failures,
      error,
    };
    results.push(result);
    console.log(
      JSON.stringify({
        browser: engineName,
        trial: result.trial,
        firstIframeLoadMs,
        mainDomContentLoadedMs: pageMetrics?.domContentLoadedMs ?? null,
        requestCount: requests.length,
        wvfsHead: result.counts.wvfsHead,
        wvfsGet: result.counts.wvfsGet,
        transferBytes: result.transferBytes,
        slowestRequests: result.requests.slice(0, 5).map(({ method, url, status, ttfbMs, elapsedMs, edgeCache }) => ({
          method,
          path: new URL(url).pathname,
          status,
          ttfbMs,
          elapsedMs,
          edgeCache,
        })),
        error,
      }),
    );
    await context.close();
  }
} finally {
  await browser.close();
}

const path = `${directory}/arcade-cold-${engineName}.json`;
await writeFile(path, JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2) + '\n');
console.log(`Saved browser waterfall measurements: ${path}`);
const samples = results
  .map((result) => result.firstIframeLoadMs)
  .filter((time) => time !== null)
  .sort((a, b) => a - b);
if (samples.length)
  console.log(`${engineName} cold iframe load median: ${samples[Math.floor(samples.length / 2)]} ms / ${samples.length} successful runs`);
if (samples.length !== trials) process.exitCode = 1;
