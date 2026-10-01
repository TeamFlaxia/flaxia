import assert from 'node:assert';
import { describe, it } from 'node:test';
import { Script } from 'node:vm';
import { isParentMessage, isSandboxMessage, STUDIO_CONSOLE_CONNECT_MESSAGE } from '../src/lib/bridge.ts';
import {
  injectStudioConsoleBridge,
  parseStudioConsoleEntry,
  STUDIO_CONSOLE_BRIDGE_SOURCE,
} from '../src/lib/editor/studio-console.ts';

describe('sandboxed Studio console bridge', () => {
  it('accepts only bounded log entries with known levels', () => {
    assert.deepEqual(parseStudioConsoleEntry({ kind: 'console', level: 'warn', text: 'careful' }), {
      kind: 'console',
      level: 'warn',
      text: 'careful',
    });
    assert.equal(parseStudioConsoleEntry({ kind: 'console', level: 'debug', text: 'ignored' }), null);
    assert.equal(parseStudioConsoleEntry({ kind: 'other', level: 'error', text: 'ignored' }), null);
    assert.equal(parseStudioConsoleEntry({ kind: 'console', level: 'error', text: 5 }), null);
    assert.equal(parseStudioConsoleEntry(null), null);
    assert.equal(parseStudioConsoleEntry({ kind: 'console', level: 'log', text: 'x'.repeat(3000) })?.text.length, 2000);
  });

  it('keeps the injected bridge script syntactically valid', () => {
    assert.doesNotThrow(() => new Script(STUDIO_CONSOLE_BRIDGE_SOURCE));
  });

  it('preserves the doctype and installs the bridge before page scripts', () => {
    const page = '<!doctype html><html><head><script>console.log("ready")</script></head></html>';
    const instrumented = injectStudioConsoleBridge(page);
    assert.ok(instrumented.startsWith('<!doctype html><script>'));
    assert.ok(instrumented.indexOf('STUDIO_CONSOLE_CONNECT') < instrumented.indexOf('console.log("ready")'));
  });

  it('uses the typed sandbox console connection message', () => {
    assert.deepEqual(STUDIO_CONSOLE_CONNECT_MESSAGE, { type: 'STUDIO_CONSOLE_CONNECT' });
    assert.ok(isSandboxMessage(STUDIO_CONSOLE_CONNECT_MESSAGE));
    assert.ok(!isParentMessage(STUDIO_CONSOLE_CONNECT_MESSAGE));
  });
});
