import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { listEditableGameSources, updateEditableGameSources } from '../src/lib/editor/game-project.ts';

async function sampleGame(): Promise<File> {
  const zip = new JSZip();
  zip.file('index.html', '<main>old</main>');
  zip.file('scripts/game.js', 'startGame();');
  zip.file('styles/game.css', 'main { color: white; }');
  zip.file('assets/icon.png', new Uint8Array([1, 2, 3]));
  return new File([await zip.generateAsync({ type: 'uint8array' })], 'sample-game.zip', { type: 'application/zip' });
}

describe('editable game packages', () => {
  it('lists validated editable sources with the launch page first', async () => {
    const sources = await listEditableGameSources(await sampleGame());
    assert.deepEqual(
      sources.map(({ path }) => path),
      ['index.html', 'scripts/game.js', 'styles/game.css'],
    );
  });

  it('accepts legacy index.htm game entry points', async () => {
    const zip = new JSZip();
    zip.file('index.htm', '<canvas></canvas>');
    const file = new File([await zip.generateAsync({ type: 'uint8array' })], 'legacy-game.zip', {
      type: 'application/zip',
    });
    assert.deepEqual(
      (await listEditableGameSources(file)).map(({ path }) => path),
      ['index.htm'],
    );
  });

  it('updates source files while preserving the rest of the ZIP package', async () => {
    const original = await sampleGame();
    const updated = await updateEditableGameSources(original, new Map([['scripts/game.js', 'startGame(2);']]));
    const zip = await JSZip.loadAsync(await updated.arrayBuffer());
    assert.equal(await zip.file('scripts/game.js')?.async('string'), 'startGame(2);');
    assert.equal(await zip.file('index.html')?.async('string'), '<main>old</main>');
    assert.deepEqual(await zip.file('assets/icon.png')?.async('uint8array'), new Uint8Array([1, 2, 3]));
    assert.equal(updated.name, original.name);
    assert.equal(updated.type, 'application/zip');
  });

  it('rejects paths outside the supported source allowlist', async () => {
    await assert.rejects(
      updateEditableGameSources(await sampleGame(), new Map([['assets/icon.png', 'not an image']])),
      /Cannot edit game file/,
    );
  });
});
