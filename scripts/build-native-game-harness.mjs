import { writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { build } from 'vite';

// Deliberately separate from npm run build: production bundles contain no harness.
await build({
  configFile: false,
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: { entry: 'scripts/native-game-harness.ts', formats: ['es'], fileName: () => '__native-game-harness.js' },
  },
});
writeFileSync(
  'dist/__native-game-test.html',
  '<!doctype html><html><meta charset="utf-8"><title>Offline game test</title><body><script type="module" src="/__native-game-harness.js"></script></body></html>',
);
const zip = new JSZip();
zip.file(
  'index.html',
  '<!doctype html><html><body><h1>Downloaded game</h1><button id="counter">0</button><p id="result"></p><script src="game.js"></script></body></html>',
);
zip.file(
  'game.js',
  `
let parentBlocked = false;
try { parent.document.body; } catch { parentBlocked = true; }
const bridgeBlocked = typeof window.androidBridge === 'undefined' && !window.__TAURI_INTERNALS__;
const button = document.getElementById('counter');
button.textContent = localStorage.getItem('counter') || '0';
button.onclick = () => { button.textContent = String(Number(button.textContent) + 1); localStorage.setItem('counter', button.textContent); };
fetch('data.json').then(r => r.json()).then(data => {
  document.getElementById('result').textContent = JSON.stringify({ parentBlocked, bridgeBlocked, asset: data.value });
});
`,
);
zip.file('data.json', '{"value":42}');
writeFileSync('dist/__game-fixture.zip', await zip.generateAsync({ type: 'nodebuffer' }));
