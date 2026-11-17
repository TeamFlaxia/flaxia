// Built-CSS smoke test for the Phase 5 layer entry.
//
// This loads the actual output of `vite build` (dist/assets/main-*.css), not a
// hand-written fixture. Run with:
//   npm run test:styles:browser
//   STYLES_BROWSER=firefox npm run test:styles:browser
//   STYLES_BROWSER=webkit npm run test:styles:browser
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium, firefox, webkit } = await import(playwrightModule);
const browserName = process.env.STYLES_BROWSER ?? 'chromium';
const engine = { chromium, firefox, webkit }[browserName];
assert.ok(engine, `unknown STYLES_BROWSER: ${browserName}`);

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
const assetsDir = join(distDir, 'assets');
const cssFiles = readdirSync(assetsDir).filter((file) => file.startsWith('main-') && file.endsWith('.css'));
assert.ok(cssFiles.length > 0, 'vite build must produce dist/assets/main-*.css before this test');
const cssHref = `/assets/${cssFiles[0]}`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${cssHref}">
</head>
<body>
<div id="fixture">
  <div class="fx-box" id="ratio-box" style="width:320px; --fx-ratio:16 / 9">
    <div class="fx-box__inner"></div>
  </div>
</div>
</body>
</html>`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

test('built app CSS keeps legacy/primitives layers and primitive geometry', { timeout: 60_000 }, async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    if (url.pathname === cssHref) {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(readFileSync(join(distDir, cssHref)));
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });

  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  let browser;
  try {
    try {
      browser = await engine.launch(browserName === 'chromium' ? { channel: 'chrome' } : {});
    } catch {
      browser = await engine.launch();
    }

    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });

    const result = await page.evaluate(() => {
      const sheet = [...document.styleSheets].find((entry) => entry.href?.includes('/assets/main-'));
      if (!sheet) return { error: 'stylesheet missing' };

      const layerNames = [];
      const walk = (rules) => {
        for (const rule of Array.from(rules)) {
          if (rule.constructor.name === 'CSSLayerBlockRule') {
            const name = rule.name;
            layerNames.push(name);
            walk(rule.cssRules);
          } else if ('cssRules' in rule) {
            walk(rule.cssRules);
          }
        }
      };
      walk(sheet.cssRules);

      // Insert one rule in each existing layer. The declared layer order must
      // make primitives win even though both selectors have equal specificity.
      sheet.insertRule('@layer legacy { .layer-probe { color: rgb(1, 2, 3); } }', sheet.cssRules.length);
      sheet.insertRule('@layer primitives { .layer-probe { color: rgb(4, 5, 6); } }', sheet.cssRules.length);
      const probe = document.createElement('div');
      probe.className = 'layer-probe';
      probe.textContent = 'probe';
      document.body.appendChild(probe);

      const box = document.getElementById('ratio-box');
      if (!box) return { error: 'ratio box missing' };
      const style = getComputedStyle(box);
      const rect = box.getBoundingClientRect();
      return {
        layers: layerNames,
        probeColor: getComputedStyle(probe).color,
        box: {
          width: rect.width,
          height: rect.height,
          position: style.position,
          contain: style.contain,
          aspectRatio: style.aspectRatio,
        },
      };
    });

    assert.equal(result.error, undefined, result.error);
    assert.ok(result.layers.includes('legacy'), `legacy layer missing: ${result.layers.join(',')}`);
    assert.ok(result.layers.includes('primitives'), `primitives layer missing: ${result.layers.join(',')}`);
    assert.equal(result.probeColor, 'rgb(4, 5, 6)', 'primitives layer must win over legacy');
    assert.ok(Math.abs(result.box.width - 320) < 1, `unexpected width: ${result.box.width}`);
    assert.ok(Math.abs(result.box.height - 180) < 1, `16:9 aspect ratio not reserved: ${result.box.height}`);
    assert.equal(result.box.position, 'relative');
    assert.match(result.box.contain, /layout/);
    assert.match(result.box.contain, /paint/);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
