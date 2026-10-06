import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isParentMessage, isSandboxMessage, MAX_SANDBOX_ZIP_PREVIEW_BYTES } from '../src/lib/bridge.ts';

test('sandbox ZIP preview initialization and request use the shared schema', () => {
  const valid = { type: 'EXECUTE_ZIP', postId: 'preview-123', zipData: new ArrayBuffer(8) };
  assert.equal(isSandboxMessage({ type: 'PREVIEW_INIT', requestId: 'preview-123' }), true);
  assert.equal(isSandboxMessage({ type: 'PREVIEW_INIT', requestId: '../api' }), false);
  assert.equal(isSandboxMessage(valid), true);
  assert.equal(isSandboxMessage({ ...valid, postId: '../api' }), false);
  assert.equal(isSandboxMessage({ ...valid, zipData: new Uint8Array(8) }), false);
  assert.equal(isSandboxMessage({ ...valid, zipData: new ArrayBuffer(MAX_SANDBOX_ZIP_PREVIEW_BYTES + 1) }), false);
});

test('sandbox ZIP preview replies are typed and capped', () => {
  assert.equal(isParentMessage({ type: 'ZIP_PREVIEW_READY', requestId: 'preview-123' }), true);
  assert.equal(isParentMessage({ type: 'ZIP_READY', postId: 'preview-123' }), true);
  assert.equal(isParentMessage({ type: 'ZIP_ERROR', postId: 'preview-123', error: 'Invalid ZIP' }), true);
  assert.equal(isParentMessage({ type: 'ZIP_ERROR', postId: 'preview-123', error: 'x'.repeat(501) }), false);
  assert.equal(isParentMessage({ type: 'ZIP_READY', postId: '../api' }), false);
});

test('opaque Arcade multiplayer requests are validated and bounded', () => {
  assert.equal(isParentMessage({ type: 'MULTIPLAYER_CONNECT', gameId: 'game-123', roomId: 'room-123' }), true);
  assert.equal(isParentMessage({ type: 'MULTIPLAYER_CONNECT', gameId: 'x'.repeat(129) }), false);
  assert.equal(isParentMessage({ type: 'MULTIPLAYER_SET_READY', ready: true }), true);
  assert.equal(isParentMessage({ type: 'MULTIPLAYER_SET_READY', ready: 'yes' }), false);
  assert.equal(isParentMessage({ type: 'MULTIPLAYER_INPUT', input: 'x'.repeat(65_537) }), false);
  assert.equal(isParentMessage({ type: 'MULTIPLAYER_SEND_PEER_DATA', data: 'x'.repeat(65_537) }), false);
});
