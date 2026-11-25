// Navigation must feel instant: a 2px fixed top bar owned by nav-loading.ts and
// driven by SvelteKit's beforeNavigate/afterNavigate hooks.
import './render/setup.ts';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, it, mock } from 'node:test';
import { beginNavigation, endNavigation } from '../src/lib/nav-loading.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

/** Extract a top-level CSS block beginning at `marker`. */
function block(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `unterminated ${marker}`);
  return source.slice(start, end);
}

describe('navigation progress bar', () => {
  afterEach(() => {
    endNavigation();
    document.querySelector('#nav-progress')?.remove();
    mock.timers.reset();
  });

  it('mounts one module-owned bar for each navigation generation', () => {
    const first = beginNavigation();
    const second = beginNavigation();

    assert.notEqual(first, second, 'each navigation needs its own generation token');
    const bars = document.querySelectorAll('#nav-progress');
    assert.equal(bars.length, 1, 'concurrent navigations must share a single bar');
    assert.equal(bars[0]?.className, 'nav-progress');
    assert.equal(bars[0]?.parentNode, document.body);
  });

  it('ignores cleanup from a stale navigation generation', () => {
    const stale = beginNavigation();
    const current = beginNavigation();

    endNavigation(stale);
    assert.ok(document.querySelector('#nav-progress'), 'a stale end must not remove the current bar');

    endNavigation(current);
    assert.equal(document.querySelector('#nav-progress'), null);
  });

  it('watchdog removes the bar when afterNavigate never fires', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    beginNavigation();
    assert.ok(document.querySelector('#nav-progress'));

    mock.timers.tick(6000);
    assert.equal(document.querySelector('#nav-progress'), null, 'a cancelled navigation must not leave a bar');
  });

  it('root layout drives the bar with both SvelteKit navigation hooks', async () => {
    const layout = await read('src/routes/+layout.svelte');

    assert.match(layout, /import \{[^}]*\bbeforeNavigate\b[^}]*\} from '\$app\/navigation'/);
    assert.match(layout, /import \{[^}]*\bafterNavigate\b[^}]*\} from '\$app\/navigation'/);
    assert.match(layout, /from '\.\.\/lib\/nav-loading\.ts'/);
    assert.match(layout, /beforeNavigate\(\(\) => \{[\s\S]*closeLeftNav\(\)[\s\S]*beginNavigation\(\)/);
    assert.match(layout, /afterNavigate\(\(\) => endNavigation\(/);

    // Existing root-layout behaviour must survive the wiring.
    assert.match(layout, /let localeVersion = \$state\(0\)/);
    assert.match(layout, /bootShell\(\)/);
    assert.match(layout, /window\.addEventListener\('popstate', sync\)/);
  });

  it('motion.css keeps the bar out of layout and honours reduced motion', async () => {
    const css = await read('src/styles/redesign/motion.css');
    const rule = block(css, '.nav-progress {');

    for (const declaration of [
      'position: fixed',
      'inset-block-start: 0',
      'inset-inline: 0',
      'block-size: 2px',
      'pointer-events: none',
      'z-index:',
    ]) {
      assert.ok(rule.includes(declaration), `.nav-progress must declare ${declaration}`);
    }

    const keyframes = block(css, '@keyframes nav-progress-sweep {');
    assert.match(keyframes, /transform:/);
    assert.match(keyframes, /opacity:/);
    assert.doesNotMatch(
      keyframes,
      /\b(width|height|top|left|margin|padding|inset)\s*:/,
      'animate transform/opacity only',
    );

    const reduced = block(css, '@media (prefers-reduced-motion: reduce) {');
    assert.match(reduced, /\.nav-progress/);
    assert.match(reduced, /animation:\s*none/);
  });

  it('keeps the legacy spinner exports for the existing render tests', async () => {
    const source = await read('src/lib/nav-loading.ts');
    for (const name of ['showNavigationSpinner', 'hideNavigationSpinner', 'isNavigationSpinnerMounted']) {
      assert.match(source, new RegExp(`export function ${name}\\(`));
    }
  });
});
