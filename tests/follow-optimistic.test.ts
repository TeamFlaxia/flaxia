// Follow buttons must give immediate visual feedback: flip the visible
// following state before awaiting the network request, and restore it when the
// request fails. Source inspection keeps these UI invariants testable without
// mounting a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function toggleFollowBody(source: string): string {
  const match = source.match(/async function toggleFollow[\s\S]*?\n}\n/);
  assert.ok(match, 'toggleFollow function not found');
  return match[0];
}

function catchBody(body: string): string {
  const match = body.match(/catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(match, 'catch branch not found');
  return match[1];
}

function notOkBody(body: string): string {
  const match = body.match(/if \(!response\.ok\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(match, '!response.ok branch not found');
  return match[1];
}

test('follower list modal toggles the visible state before awaiting the request', async () => {
  const source = await read('src/lib/svelte/FollowerListModal.svelte');
  const body = toggleFollowBody(source);

  const fetchAt = body.indexOf('await fetch(');
  const optimisticAt = body.search(/is_following:\s*!wasFollowing/);

  assert.ok(fetchAt !== -1, 'toggleFollow should call fetch');
  assert.ok(optimisticAt !== -1, 'toggleFollow should flip is_following optimistically');
  assert.ok(optimisticAt < fetchAt, 'the optimistic flip must happen before await fetch(');

  // The busy guard stays for duplicate submissions, but the button must not
  // remain visually disabled while the request is in flight.
  assert.match(body, /if \(busy\[user\.username\]\) return/);
  assert.doesNotMatch(
    source,
    /disabled=\{busy\[user\.username\]\}/,
    'button must not be disabled for the whole request',
  );
});

test('follower list modal rolls the visible state back on failure', async () => {
  const source = await read('src/lib/svelte/FollowerListModal.svelte');
  const body = toggleFollowBody(source);

  assert.match(catchBody(body), /is_following:\s*wasFollowing/, 'catch must restore the original following state');
  assert.match(
    notOkBody(body),
    /is_following:\s*wasFollowing/,
    'a non-OK HTTP response must restore the original following state',
  );
});

test('remote profile toggles the visible state before awaiting the federation request', async () => {
  const source = await read('src/lib/svelte/RemoteProfilePage.svelte');
  const body = toggleFollowBody(source);

  const fetchAt = body.indexOf('await fetch(');
  const optimisticAt = body.indexOf('following = !following');

  assert.ok(fetchAt !== -1, 'toggleFollow should call fetch');
  assert.ok(optimisticAt !== -1, 'toggleFollow should flip following optimistically');
  assert.ok(optimisticAt < fetchAt, 'the optimistic flip must happen before await fetch(');

  assert.match(body, /if \(followBusy\) return/);
  assert.doesNotMatch(source, /disabled=\{followBusy\}/, 'button must not be disabled for the whole request');
});

test('remote profile rolls the visible state back on failure', async () => {
  const source = await read('src/lib/svelte/RemoteProfilePage.svelte');
  const body = toggleFollowBody(source);

  assert.match(catchBody(body), /following\s*=\s*!following/, 'catch must restore the original following state');
  assert.match(
    notOkBody(body),
    /following\s*=\s*!following/,
    'a non-OK HTTP response must restore the original following state',
  );
});
