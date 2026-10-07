import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createWvfsImageCorsCompatScript } from '../src/lib/wvfs-image-cors.ts';
import { injectBaseTag } from '../src/lib/wvfs-zip-server.ts';

const GAME_BASE = '/api/wvfs-zip/test-post/';
const DOCUMENT_BASE = `https://sandbox.example${GAME_BASE}`;

function installCompatScript(): new () => {
  requestedCrossOrigin: string | null;
  src: string;
  crossOrigin: string | null;
  setAttribute(name: string, value: string): void;
} {
  class TestElement {
    private readonly attributes = new Map<string, string>();

    setAttribute(name: string, value: string): void {
      this.attributes.set(String(name).toLowerCase(), String(value));
    }

    getAttribute(name: string): string | null {
      return this.attributes.get(name.toLowerCase()) ?? null;
    }

    hasAttribute(name: string): boolean {
      return this.attributes.has(name.toLowerCase());
    }
  }

  class TestImageElement extends TestElement {
    requestedCrossOrigin: string | null = null;
    private source = '';

    get src(): string {
      return this.source;
    }

    set src(value: string) {
      this.requestedCrossOrigin = this.crossOrigin;
      this.source = String(value);
    }

    get crossOrigin(): string | null {
      return this.getAttribute('crossorigin');
    }

    set crossOrigin(value: string | null) {
      if (value === null) {
        return;
      }
      this.setAttribute('crossorigin', value);
    }
  }

  runInNewContext(createWvfsImageCorsCompatScript(GAME_BASE), {
    document: { baseURI: DOCUMENT_BASE },
    Element: TestElement,
    HTMLImageElement: TestImageElement,
    URL,
  });
  return TestImageElement;
}

describe('WVFS image CORS compatibility', () => {
  it('sets anonymous CORS before loading local images through src', () => {
    const ImageElement = installCompatScript();

    const image = new ImageElement();
    image.src = 'img/system/Window.png';

    assert.equal(image.requestedCrossOrigin, 'anonymous');
    assert.equal(image.crossOrigin, 'anonymous');
  });

  it('handles local src attributes but leaves external and sibling-post images unchanged', () => {
    const ImageElement = installCompatScript();

    const localImage = new ImageElement();
    localImage.setAttribute('SRC', 'img/system/Window.png');
    assert.equal(localImage.crossOrigin, 'anonymous');

    const externalImage = new ImageElement();
    externalImage.src = 'https://images.example/window.png';
    assert.equal(externalImage.requestedCrossOrigin, null);

    const siblingPostImage = new ImageElement();
    siblingPostImage.src = '/api/wvfs-zip/test-post-evil/Window.png';
    assert.equal(siblingPostImage.requestedCrossOrigin, null);
  });

  it('preserves an explicit crossOrigin mode', () => {
    const ImageElement = installCompatScript();

    const image = new ImageElement();
    image.crossOrigin = 'use-credentials';
    image.src = 'img/system/Window.png';

    assert.equal(image.requestedCrossOrigin, 'use-credentials');
  });

  it('injects the shim after the game base URL and before game scripts', () => {
    const html = injectBaseTag('<html><head><script src="js/rpg_core.js"></script></head></html>', 'test-post');
    const shimPosition = html.indexOf('Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src")');
    const gameScriptPosition = html.indexOf('js/rpg_core.js');

    assert.ok(shimPosition >= 0, 'the image compatibility shim should be injected');
    assert.ok(shimPosition < gameScriptPosition, 'the shim must run before RPG Maker loads');
    assert.ok(html.includes(`<base href="${GAME_BASE}">`));
  });
});
