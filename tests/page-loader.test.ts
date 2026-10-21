// Page loading overlay: show/hide lifecycle (with a minimal DOM fake,
// since these suites run in Node without a browser).
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

class FakeClassList {
  private set = new Set<string>();
  add(c: string): void {
    this.set.add(c);
  }
  remove(c: string): void {
    this.set.delete(c);
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
}

class FakeEl {
  className = '';
  id = '';
  innerHTML = '';
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  onmouseenter: (() => void) | null = null;
  onmouseleave: (() => void) | null = null;
  classList = new FakeClassList();
  children: FakeEl[] = [];
  appendChild(c: FakeEl): void {
    this.children.push(c);
  }
  querySelector(_sel: string): FakeEl {
    return new FakeEl();
  }
}

const appended: FakeEl[] = [];
const fakeBody = new FakeEl();
(fakeBody as unknown as { appendChild(c: FakeEl): void }).appendChild = (c: FakeEl) => {
  appended.push(c);
};

(globalThis as unknown as Record<string, unknown>).document = {
  createElement: () => new FakeEl(),
  body: fakeBody,
  querySelector: (sel: string) => (sel === '#page-loader' ? (appended[appended.length - 1] ?? null) : null),
};
(globalThis as unknown as Record<string, unknown>).window = { location: { reload: () => {} } };

const { showPageLoader, hidePageLoader } = await import('../src/lib/page-loader.ts');

describe('page-loader', () => {
  afterEach(() => {
    hidePageLoader();
  });

  it('shows the overlay on first call', () => {
    const before = appended.length;
    showPageLoader();
    // Either a fresh element (first call ever) or reuse of the shared one.
    const loader =
      appended.length > before
        ? appended[appended.length - 1]
        : (globalThis as unknown as { document: { querySelector(s: string): FakeEl | null } }).document.querySelector(
            '#page-loader',
          )!;
    if (appended.length > before) {
      assert.equal(loader.id, 'page-loader');
      assert.match(loader.innerHTML, /Loading/);
    }
    assert.ok(loader.classList.contains('active'));
  });

  it('hide removes the active class without throwing', () => {
    showPageLoader();
    const loader = (
      globalThis as unknown as { document: { querySelector(s: string): FakeEl | null } }
    ).document.querySelector('#page-loader')!;
    assert.ok(loader.classList.contains('active'));
    hidePageLoader();
    assert.ok(!loader.classList.contains('active'));
  });

  it('hide before show is a no-op', () => {
    hidePageLoader();
  });
});
