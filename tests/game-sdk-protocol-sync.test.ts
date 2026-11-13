import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The game SDK speaks the same wire protocol as the parent bridge
 * (`src/lib/bridge.ts`). The two live in different build graphs — the SDK is a
 * standalone package bundled into the sandbox worker, the bridge is part of the
 * main app — so nothing but this test keeps them from drifting apart.
 *
 * If a frame is added to one side, add it to the other (or, for preview-shell
 * frames, to the allowlist below) and update `docs/developer/game-api.md`.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const bridgeSource = readFileSync(join(root, 'src/lib/bridge.ts'), 'utf8');
const protocolSource = readFileSync(join(root, 'packages/game-sdk/src/protocol.ts'), 'utf8');

/** Type names of every member of `export type <unionName> = ...`. */
function unionTypes(source: string, unionName: string): Set<string> {
  const declaration = source.indexOf(`export type ${unionName} =`);
  assert.ok(declaration >= 0, `union ${unionName} not found`);

  const lines = source.slice(declaration).split('\n').slice(1);
  const members: string[] = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('|')) members.push(line);
    else if (members.length > 0) break;
  }

  const types = new Set<string>();
  for (const member of members) {
    const match = member.match(/type:\s*'([^']+)'/);
    assert.ok(match, `member of ${unionName} has no type literal: ${member}`);
    types.add(match[1]);
  }
  assert.ok(types.size > 0, `union ${unionName} has no members`);
  return types;
}

function isSubset(subset: Set<string>, superset: Set<string>, label: string): void {
  const missing = [...subset].filter((type) => !superset.has(type)).sort();
  assert.deepEqual(missing, [], `${label} contains frames the parent does not know: ${missing.join(', ')}`);
}

const parentMessage = unionTypes(bridgeSource, 'ParentMessage');
const sandboxMessage = unionTypes(bridgeSource, 'SandboxMessage');
const gameToParent = unionTypes(protocolSource, 'GameToParentMessage');
const parentToGame = unionTypes(protocolSource, 'ParentToGameMessage');

/** Frames owned by the trusted ZIP preview shell, never by game code. */
const PREVIEW_SHELL_ONLY = new Set(['DOCUMENT_DATA', 'PREVIEW_INIT', 'EXECUTE_ZIP']);

describe('Game SDK protocol sync', () => {
  it('every game -> parent frame is accepted by the parent bridge', () => {
    isSubset(gameToParent, parentMessage, 'GameToParentMessage');
  });

  it('every parent -> game frame is accepted by the parent bridge', () => {
    // The parent sends platform frames through SandboxMessage and multiplayer
    // frames through ParentMessage, so the union is the accepted set.
    const acceptedByParent = new Set([...parentMessage, ...sandboxMessage]);
    isSubset(parentToGame, acceptedByParent, 'ParentToGameMessage');
  });

  it('the game SDK knows every parent -> sandbox frame except preview-shell frames', () => {
    const known = new Set([...parentToGame, ...PREVIEW_SHELL_ONLY]);
    const missing = [...sandboxMessage].filter((type) => !known.has(type)).sort();
    assert.deepEqual(missing, [], `SandboxMessage frames missing from the game SDK: ${missing.join(', ')}`);
  });

  it('keeps the shared multiplayer frame names aligned', () => {
    const gameMultiplayer = new Set([...gameToParent].filter((type) => type.startsWith('MULTIPLAYER_')));
    const parentMultiplayer = new Set([...parentMessage].filter((type) => type.startsWith('MULTIPLAYER_')));
    const sdkParentMultiplayer = new Set([...parentToGame].filter((type) => type.startsWith('MULTIPLAYER_')));

    // Every frame the game can send must exist on the parent side.
    isSubset(gameMultiplayer, parentMultiplayer, 'game MULTIPLAYER_* frames');
    // Every multiplayer frame the parent can send must exist in the SDK.
    isSubset(sdkParentMultiplayer, parentMultiplayer, 'SDK MULTIPLAYER_* frames');

    const gameOnly = [...gameMultiplayer].filter((type) => !sdkParentMultiplayer.has(type)).sort();
    assert.deepEqual(gameOnly, [], `game-only MULTIPLAYER_* frames: ${gameOnly.join(', ')}`);
  });
});
