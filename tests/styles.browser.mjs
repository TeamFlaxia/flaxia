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
  <div class="post-stage post-stage--zip fx-box" id="stage-box" style="width:320px; --fx-ratio:16 / 9"></div>
  <div class="image-preview fx-box" id="image-box" style="width:320px; --fx-ratio:16 / 9">
    <img class="image-preview-img" alt="">
  </div>
  <div class="link-preview-image-container fx-box" id="link-box" style="width:320px; --fx-ratio:1.914"></div>
  <div class="data-saver-placeholder fx-box" id="saver-box" style="width:320px; --fx-ratio:16 / 9"></div>
  <div class="media-carousel-track" style="width:320px">
    <div class="media-carousel-slide fx-box" id="slide-box" style="--fx-ratio:16 / 9"></div>
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

      const measure = (id) => {
        const element = document.getElementById(id);
        if (!element) return null;
        const computed = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return {
          width: bounds.width,
          height: bounds.height,
          position: computed.position,
          display: computed.display,
          contain: computed.contain,
          aspectRatio: computed.aspectRatio,
          paddingBottom: computed.paddingBottom,
          overflow: computed.overflow,
          borderRadius: computed.borderTopLeftRadius,
        };
      };

      return {
        layers: layerNames,
        probeColor: getComputedStyle(probe).color,
        box: measure('ratio-box'),
        stage: measure('stage-box'),
        image: measure('image-box'),
        link: measure('link-box'),
        saver: measure('saver-box'),
        slide: measure('slide-box'),
        imageChild: (() => {
          const img = document.querySelector('#image-box .image-preview-img');
          if (!img) return null;
          const bounds = img.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        })(),
      };
    });

    assert.equal(result.error, undefined, result.error);
    assert.ok(result.layers.includes('legacy'), `legacy layer missing: ${result.layers.join(',')}`);
    assert.ok(result.layers.includes('primitives'), `primitives layer missing: ${result.layers.join(',')}`);
    assert.equal(result.probeColor, 'rgb(4, 5, 6)', 'primitives layer must win over legacy');

    assert.ok(result.box, 'ratio box missing');
    assert.ok(Math.abs(result.box.width - 320) < 1, `unexpected width: ${result.box.width}`);
    assert.ok(Math.abs(result.box.height - 180) < 1, `16:9 aspect ratio not reserved: ${result.box.height}`);
    assert.equal(result.box.position, 'relative');
    assert.match(result.box.contain, /layout/);
    assert.match(result.box.contain, /paint/);

    // PostStage ZIP/SWF: primitives must beat the legacy padding-bottom box.
    assert.ok(result.stage, 'stage box missing');
    assert.ok(Math.abs(result.stage.width - 320) < 1, `unexpected stage width: ${result.stage.width}`);
    assert.ok(Math.abs(result.stage.height - 180) < 2, `stage 16:9 not reserved: ${result.stage.height}`);
    assert.equal(result.stage.paddingBottom, '0px', 'legacy padding-bottom must be overridden');
    assert.match(result.stage.aspectRatio, /16\s*\/\s*9|1\.77/);

    // ImagePreview 16:9: fx-box owns the height, not the legacy absolute fill.
    assert.ok(result.image, 'image box missing');
    assert.ok(Math.abs(result.image.width - 320) < 1, `unexpected image width: ${result.image.width}`);
    assert.ok(Math.abs(result.image.height - 180) < 2, `image 16:9 not reserved: ${result.image.height}`);
    assert.equal(result.image.display, 'block');
    assert.equal(result.image.position, 'relative');
    assert.equal(result.image.overflow, 'clip');
    // The box owns the height: the image itself must not overflow the reserved
    // frame (the legacy rule made it 100% of a padded parent).
    assert.ok(result.imageChild, 'image child missing');
    assert.ok(result.imageChild.height <= 181, `image child overflows the reserved box: ${result.imageChild.height}`);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
