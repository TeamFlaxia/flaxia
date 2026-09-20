// True end-to-end DM E2EE flow test. Unlike messenger-dm-e2e.test.ts (which
// only checks the prekey/consume endpoints), this exercises the real
// encrypt/decrypt path with two distinct identities talking through the actual
// API (prekeys reservation, OPK consume, ratchet-session persistence) — exactly
// the path that broke in production ("new messages also fail to decrypt after
// re-establishing the session").
//
// Requires a running `npm run dev:test` server on http://localhost:8788.
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

const ROOT = join(import.meta.dirname, '..');
const ENVELOPE = join(tmpdir(), `dmflow-${Date.now()}.json`);

interface ActorResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
function runActor(env: Record<string, string>): ActorResult {
  const res = spawnSync('node', ['--experimental-strip-types', 'tests/helpers/actor-dm.ts'], {
    cwd: ROOT,
    env: { ...process.env, DEVICE_ID: env.DEVICE_ID ?? `device-${env.ROLE ?? 'x'}`, ...env },
    encoding: 'utf8',
  });
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

let aId = '';
let bId = '';
let aCookie = '';
let bCookie = '';
let dmId = '';

async function userIdFor(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/me`, { headers: { Cookie: cookie } });
  const data = (await res.json()) as { user: { id: string } };
  return data.user.id;
}

before(async () => {
  await resetDb();
  const a = await seedUserAndLogin('dmflowA');
  const b = await seedUserAndLogin('dmflowB');
  aCookie = a.cookie;
  bCookie = b.cookie;
  aId = await userIdFor(aCookie);
  bId = await userIdFor(bCookie);
  dmId = `conv_dmflow_${Date.now()}`;
  // Each user must publish its E2EE identity before the other can fetch a
  // prekey bundle. Run both bootstrap actors up front (separate processes so
  // each gets a distinct in-memory identity).
  let bs = runActor({ ROLE: 'A', COOKIE: aCookie, PEERID: bId, DMID: dmId, STEP: 'bootstrap' });
  assert.equal(bs.ok, true, `A bootstrap failed:\n${bs.stderr}`);
  bs = runActor({ ROLE: 'B', COOKIE: bCookie, PEERID: aId, DMID: dmId, STEP: 'bootstrap' });
  assert.equal(bs.ok, true, `B bootstrap failed:\n${bs.stderr}`);
});

describe('DM E2EE v2 full flow', () => {
  it('A->B initial message decrypts, B->A reply decrypts', () => {
    let r = runActor({
      ROLE: 'A',
      COOKIE: aCookie,
      PEERID: bId,
      DMID: dmId,
      STEP: 'encrypt',
      OUT: ENVELOPE,
      PLAINTEXT: 'hello',
    });
    assert.equal(r.ok, true, `A encrypt failed:\n${r.stderr}`);
    r = runActor({
      ROLE: 'B',
      COOKIE: bCookie,
      PEERID: aId,
      DMID: dmId,
      STEP: 'decrypt-reply',
      IN: ENVELOPE,
      OUT: ENVELOPE,
      EXPECT: 'hello',
      PLAINTEXT: 'pong',
    });
    assert.equal(r.ok, true, `B decrypt/reply failed:\n${r.stderr}`);
    r = runActor({
      ROLE: 'A',
      COOKIE: aCookie,
      PEERID: bId,
      DMID: dmId,
      STEP: 'decrypt',
      IN: ENVELOPE,
      EXPECT: 'pong',
    });
    assert.equal(r.ok, true, `A decrypt reply failed:\n${r.stderr}`);
  });

  it('re-establishing (reset) the session still lets new messages decrypt both ways', () => {
    let r = runActor({
      ROLE: 'A',
      COOKIE: aCookie,
      PEERID: bId,
      DMID: dmId,
      STEP: 'encrypt-reset',
      OUT: ENVELOPE,
      PLAINTEXT: 'after-reset',
    });
    assert.equal(r.ok, true, `A reset+encrypt failed:\n${r.stderr}`);
    r = runActor({
      ROLE: 'B',
      COOKIE: bCookie,
      PEERID: aId,
      DMID: dmId,
      STEP: 'decrypt',
      IN: ENVELOPE,
      EXPECT: 'after-reset',
    });
    assert.equal(r.ok, true, `B decrypt after reset failed:\n${r.stderr}`);

    r = runActor({
      ROLE: 'B',
      COOKIE: bCookie,
      PEERID: aId,
      DMID: dmId,
      STEP: 'encrypt',
      OUT: ENVELOPE,
      PLAINTEXT: 'reply-after-reset',
    });
    assert.equal(r.ok, true, `B encrypt after reset failed:\n${r.stderr}`);
    r = runActor({
      ROLE: 'A',
      COOKIE: aCookie,
      PEERID: bId,
      DMID: dmId,
      STEP: 'decrypt',
      IN: ENVELOPE,
      EXPECT: 'reply-after-reset',
    });
    assert.equal(r.ok, true, `A decrypt after reset failed:\n${r.stderr}`);
  });
});

// Best-effort: clean up the temp envelope file.
try {
  rmSync(ENVELOPE, { force: true });
} catch {
  /* ignore */
}
