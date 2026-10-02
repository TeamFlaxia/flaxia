import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listEditableGameSources } from '../src/lib/editor/game-project.ts';
import { createStudioStarterFile } from '../src/lib/editor/studio-starter-files.ts';

describe('Studio starter files', () => {
  it('creates a runnable HTML canvas game for isolated preview', async () => {
    const file = await createStudioStarterFile('html-game', 'catch-the-star');
    const source = await file.text();

    assert.equal(file.name, 'catch-the-star.html');
    assert.equal(file.type, 'text/html');
    assert.match(source, /<canvas id="game"/);
    assert.match(source, /requestAnimationFrame\(frame\)/);
    assert.match(source, /addEventListener\('keydown'/);
  });

  it('creates code files with the selected language extension and starter source', async () => {
    const file = await createStudioStarterFile('typescript', 'scene.ts');

    assert.equal(file.name, 'scene.ts');
    assert.equal(file.type, 'text/typescript');
    assert.match(await file.text(), /function main\(\): void/);
  });

  it('adds the extension and rejects empty or path-like names', async () => {
    assert.equal((await createStudioStarterFile('css', 'theme')).name, 'theme.css');
    await assert.rejects(createStudioStarterFile('javascript', '  '), /Enter a file name/);
    await assert.rejects(createStudioStarterFile('json', '../secrets'), /without folders/);
    await assert.rejects(createStudioStarterFile('json', 'bad\\name'), /without folders/);
    await assert.rejects(createStudioStarterFile('json', 'bad\u0001name'), /control characters/);
  });

  it('creates a multi-file ZIP game project that can be edited and previewed', async () => {
    const file = await createStudioStarterFile('game-project', 'space-chase');
    const sources = await listEditableGameSources(file);

    assert.equal(file.name, 'space-chase.zip');
    assert.equal(file.type, 'application/zip');
    assert.deepEqual(
      sources.map(({ path }) => path),
      ['index.html', 'src/main.js', 'styles.css'],
    );
    assert.match(sources[0].source, /\.\/styles\.css/);
    assert.match(sources[0].source, /\.\/src\/main\.js/);
    assert.match(sources[1].source, /requestAnimationFrame\(frame\)/);
    assert.match(sources[2].source, /#b8ef6a/);
  });
});
