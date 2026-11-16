// Optional real-browser checks for @flaxia/render (flaxia-render).
//
// Run with:
//   npm run test:render:browser
//   RENDER_BROWSER=firefox npm run test:render:browser
//
// The page is served locally and inlines dist/render.iife.js, so no application
// server, database or auth session is required.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';

const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
const { chromium, firefox, webkit } = await import(playwrightModule);
const browserName = process.env.RENDER_BROWSER ?? 'chromium';
const engine = { chromium, firefox, webkit }[browserName];
assert.ok(engine, `unknown RENDER_BROWSER: ${browserName}`);

const distPath = new URL('../packages/flaxia-render/dist/render.iife.js', import.meta.url);
const engineSource = await readFile(distPath, 'utf8');

const pageHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; font-family: system-ui, sans-serif; }
  #app { width: 600px; }
  .card { display: flex; align-items: center; gap: 8px; height: 96px; margin: 4px 0; border: 1px solid #ccc; }
  .card iframe { width: 160px; height: 80px; }
</style>
<script>
  window.__cls = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) window.__cls += entry.value;
    }
  }).observe({ type: 'layout-shift', buffered: true });
</script>
</head>
<body>
<div id="app"></div>
<script>${engineSource}</script>
<script>
(() => {
  const { each, flushEffects, html, mount, signal, when } = FlaxiaRender;
  const rows = signal([
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ]);
  const open = signal(false);
  const source = (id) => '<!doctype html><p id="marker">' + id + '</p>';

  mount(document.getElementById('app'), () => html\`
    <section>
      \${each(
        () => rows(),
        (row) => row.id,
        (row) => html\`
          <article class="card" data-id=\${row().id}>
            <span class="label">\${() => row().label}</span>
            <iframe title=\${row().id} srcdoc=\${() => source(row().id)}></iframe>
          </article>
        \`,
      )}
      \${when(open, () => html\`<p class="extra">extra</p>\`)}
    </section>
  \`);

  window.__render = { rows, open, flushEffects };
})();
</script>
</body>
</html>`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

test('real browser: keyed reorder, hidden iframe and text identity', { timeout: 60_000 }, async () => {
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(pageHtml);
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
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 3);

    const result = await page.evaluate(async () => {
      const byId = (id) => document.querySelector(`.card[data-id="${id}"]`);
      const frameById = (id) => byId(id)?.querySelector('iframe');
      const textNode = (id) =>
        [...(byId(id)?.querySelector('.label')?.childNodes ?? [])].find((node) => node.nodeType === 3);

      const beforeFrames = {
        a: frameById('a'),
        b: frameById('b'),
        c: frameById('c'),
      };
      const beforeWindows = {
        a: beforeFrames.a?.contentWindow,
        b: beforeFrames.b?.contentWindow,
        c: beforeFrames.c?.contentWindow,
      };
      const beforeText = {
        a: textNode('a'),
        b: textNode('b'),
        c: textNode('c'),
      };

      // Same order, changed label: no DOM move, so the iframe browsing
      // contexts must survive and no layout should shift.
      window.__cls = 0;
      window.__render.rows.set([
        { id: 'a', label: 'A2' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ]);
      window.__render.flushEffects();
      const sameOrderWindowsPreserved =
        frameById('a')?.contentWindow === beforeWindows.a &&
        frameById('b')?.contentWindow === beforeWindows.b &&
        frameById('c')?.contentWindow === beforeWindows.c;
      const textUpdatedInPlace = textNode('a') === beforeText.a && textNode('a')?.nodeValue === 'A2';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const sameOrderCls = window.__cls;

      // Reorder. Element identity is preserved. Chromium resets an iframe's
      // browsing context when the element is moved, so `contentWindow`
      // identity is reported for diagnostics but is not asserted.
      window.__render.rows.set([
        { id: 'c', label: 'C' },
        { id: 'a', label: 'A2' },
        { id: 'b', label: 'B' },
      ]);
      window.__render.flushEffects();

      const order = [...document.querySelectorAll('.card')].map((card) => card.dataset.id);
      const framesPreserved =
        frameById('a') === beforeFrames.a && frameById('b') === beforeFrames.b && frameById('c') === beforeFrames.c;
      const windowsPreserved =
        frameById('a')?.contentWindow === beforeWindows.a &&
        frameById('b')?.contentWindow === beforeWindows.b &&
        frameById('c')?.contentWindow === beforeWindows.c;
      const textPreserved =
        textNode('a') === beforeText.a && textNode('b') === beforeText.b && textNode('c') === beforeText.c;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const reorderCls = window.__cls;

      const frame = frameById('a');
      const frameWindow = frame?.contentWindow;
      const card = byId('a');
      if (card) card.hidden = true;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (card) card.hidden = false;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const hiddenIframePreserved =
        frame?.contentWindow === frameWindow && frame?.contentDocument?.querySelector('#marker')?.textContent === 'a';

      window.__render.open.set(true);
      window.__render.flushEffects();
      const branchInserted = Boolean(document.querySelector('.extra'));
      window.__render.open.set(false);
      window.__render.flushEffects();
      const branchRemoved = !document.querySelector('.extra');

      return {
        order,
        framesPreserved,
        windowsPreserved,
        sameOrderWindowsPreserved,
        textPreserved,
        textUpdatedInPlace,
        hiddenIframePreserved,
        branchInserted,
        branchRemoved,
        sameOrderCls,
        reorderCls,
      };
    });

    assert.deepEqual(result.order, ['c', 'a', 'b']);
    assert.equal(result.framesPreserved, true, 'keyed reorder must keep iframe elements');
    assert.equal(
      result.sameOrderWindowsPreserved,
      true,
      'in-place updates without reordering must keep iframe browsing contexts',
    );
    assert.equal(result.textPreserved, true, 'keyed reorder must keep text nodes');
    assert.equal(result.textUpdatedInPlace, true, 'text updates must mutate the existing node');
    assert.equal(result.hiddenIframePreserved, true, 'hidden display must not reload an iframe');
    assert.equal(result.branchInserted, true);
    assert.equal(result.branchRemoved, true);
    assert.ok(result.sameOrderCls < 0.01, `in-place updates should not shift layout, got ${result.sameOrderCls}`);
    // Reordering moves cards on screen, which CLS correctly reports. Keep the
    // number visible without asserting it is zero.
    assert.ok(Number.isFinite(result.reorderCls));
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
