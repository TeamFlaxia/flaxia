import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStudioStarterFile } from '../src/lib/editor/studio-starter-files.ts';

describe('Studio starter files', () => {
  it('creates a runnable HTML canvas game for isolated preview', async () => {
    const file = createStudioStarterFile('html-game', 'catch-the-star');
    const source = await file.text();

    assert.equal(file.name, 'catch-the-star.html');
    assert.equal(file.type, 'text/html');
    assert.match(source, /<canvas id="game"/);
    assert.match(source, /requestAnimationFrame\(frame\)/);
    assert.match(source, /addEventListener\('keydown'/);
  });

  it('creates code files with the selected language extension and starter source', async () => {
    const file = createStudioStarterFile('typescript', 'scene.ts');

    assert.equal(file.name, 'scene.ts');
    assert.equal(file.type, 'text/typescript');
    assert.match(await file.text(), /function main\(\): void/);
  });

  it('adds the extension and rejects empty or path-like names', () => {
    assert.equal(createStudioStarterFile('css', 'theme').name, 'theme.css');
    assert.throws(() => createStudioStarterFile('javascript', '  '), /Enter a file name/);
    assert.throws(() => createStudioStarterFile('json', '../secrets'), /without folders/);
    assert.throws(() => createStudioStarterFile('json', 'bad\\name'), /without folders/);
    assert.throws(() => createStudioStarterFile('json', 'bad\u0001name'), /control characters/);
  });
});
