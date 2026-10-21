import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createWvfsCookieCompatScript } from '../src/lib/wvfs-cookie-compat.ts';
import { injectBaseTag } from '../src/lib/wvfs-zip-server.ts';

function sandboxDocument() {
  let nativeWrites = 0;
  const prototype = Object.defineProperty({}, 'cookie', {
    configurable: true,
    get() {
      throw new DOMException('Cookies unavailable in sandbox', 'SecurityError');
    },
    set() {
      nativeWrites++;
      throw new DOMException('Cookies unavailable in sandbox', 'SecurityError');
    },
  });
  const document = Object.create(prototype) as { cookie: string };
  return { document, prototype, nativeWrites: () => nativeWrites };
}

test('a cookie-reading SDK can install its API and continue game startup', async () => {
  const { document } = sandboxDocument();
  const context = {
    document,
    sdk: {} as { commercialBreak?: () => Promise<void> },
    started: false,
  };
  const sdkBoot = `void document.cookie; sdk.commercialBreak = function(){return Promise.resolve()};`;
  assert.throws(() => runInNewContext(sdkBoot, context), { name: 'SecurityError' });
  assert.equal(context.sdk.commercialBreak, undefined);

  runInNewContext(createWvfsCookieCompatScript(), context);
  runInNewContext(sdkBoot, context);
  await runInNewContext('sdk.commercialBreak().then(function(){started=true})', context);
  assert.equal(context.started, true);
});

test('disabled-cookie fallback never writes native cookies or affects another document', () => {
  const { document, prototype, nativeWrites } = sandboxDocument();
  const sibling = Object.create(prototype) as { cookie: string };
  runInNewContext(createWvfsCookieCompatScript(), { document });

  document.cookie = 'session=game-value; domain=flaxia.app';
  assert.equal(document.cookie, '');
  assert.equal(nativeWrites(), 0);
  assert.throws(() => sibling.cookie, { name: 'SecurityError' });
});

test('leaves a working native cookie getter and setter unchanged', () => {
  const document = { cookie: 'existing=value' };
  const before = Object.getOwnPropertyDescriptor(document, 'cookie');
  runInNewContext(createWvfsCookieCompatScript(), { document });
  assert.deepEqual(Object.getOwnPropertyDescriptor(document, 'cookie'), before);
  document.cookie = 'updated=value';
  assert.equal(document.cookie, 'updated=value');
});

test('does not replace cookie access that fails for an unrelated reason', () => {
  const document = Object.defineProperty({}, 'cookie', {
    configurable: true,
    get() {
      throw new TypeError('unexpected failure');
    },
  });
  runInNewContext(createWvfsCookieCompatScript(), { document });
  assert.throws(() => document.cookie, TypeError);
});

test('tolerates a non-configurable cookie property without breaking later scripts', () => {
  const document = Object.defineProperty({}, 'cookie', {
    get() {
      throw new DOMException('blocked', 'SecurityError');
    },
  });
  assert.doesNotThrow(() => runInNewContext(createWvfsCookieCompatScript(), { document }));
});

test('installs cookie compatibility before game scripts for every supported HTML shape', () => {
  for (const html of [
    '<html><head><script>bootGame()</script></head></html>',
    '<HTML><HEAD lang="en"><script>bootGame()</script></HEAD></HTML>',
    '<meta charset="utf-8"><script>bootGame()</script>',
    '<script>bootGame()</script>',
  ]) {
    const result = injectBaseTag(html, 'test-game');
    const position = result.indexOf(createWvfsCookieCompatScript());
    assert.ok(position >= 0);
    assert.ok(position < result.indexOf('bootGame()'));
    assert.ok(position > result.indexOf('<base href="/api/wvfs-zip/test-game/">'));
  }
});
