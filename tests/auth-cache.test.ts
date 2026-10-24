import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearMeCache, getMe, updateMeCache } from '../src/lib/auth-cache.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearMeCache();
});

test('concurrent session checks share one request', async () => {
  clearMeCache();
  let calls = 0;
  let complete: ((response: Response) => void) | undefined;
  globalThis.fetch = async () => {
    calls++;
    return new Promise<Response>((resolve) => {
      complete = resolve;
    });
  };
  const first = getMe();
  const second = getMe();
  assert.ok(complete);
  complete(Response.json({ user: { id: 'alice' } }));
  assert.deepEqual(await first, { user: { id: 'alice' } });
  assert.deepEqual(await second, { user: { id: 'alice' } });
  assert.equal(calls, 1);
});

test('an old session response cannot restore a user after logout or account switching', async () => {
  clearMeCache();
  let complete: ((response: Response) => void) | undefined;
  globalThis.fetch = async () =>
    new Promise<Response>((resolve) => {
      complete = resolve;
    });
  const old = getMe();
  clearMeCache();
  assert.ok(complete);
  complete(Response.json({ user: { id: 'alice' } }));
  assert.equal(await old, null);
  globalThis.fetch = async () => Response.json({ user: { id: 'bob' } });
  assert.deepEqual(await getMe(), { user: { id: 'bob' } });
});

test('a profile update is not overwritten by an older in-flight session check', async () => {
  clearMeCache();
  let complete: ((response: Response) => void) | undefined;
  globalThis.fetch = async () =>
    new Promise<Response>((resolve) => {
      complete = resolve;
    });
  const old = getMe();
  updateMeCache({ user: { id: 'alice', display_name: 'updated' } });
  assert.ok(complete);
  complete(Response.json({ user: { id: 'alice', display_name: 'old' } }));
  assert.deepEqual(await old, { user: { id: 'alice', display_name: 'updated' } });
  assert.deepEqual(await getMe(), { user: { id: 'alice', display_name: 'updated' } });
});

test('an authoritative 401 clears the session and the next call checks again', async () => {
  clearMeCache();
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
  assert.equal(await getMe(), null);
  globalThis.fetch = async () => Response.json({ user: { id: 'bob' } });
  assert.deepEqual(await getMe(), { user: { id: 'bob' } });
});
