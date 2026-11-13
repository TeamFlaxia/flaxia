import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import JSZip from 'jszip';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

/**
 * Game-authored titles (称号). These exercise the server contract behind the
 * Game API's CREATE_TITLE / AWARD_TITLE frames. Only the author of a real ZIP
 * game post may define titles; players may only award definitions that already
 * belong to the game they are running.
 */

async function createGamePost(cookie: string): Promise<string> {
  const prep = await fetch(`${BASE_URL}/api/posts/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ filename: 'game.zip' }),
  });
  assert.equal(prep.status, 200);
  const prepData = (await prep.json()) as { postId?: string; zipUploadUrl?: string; zipKey?: string };
  assert.ok(prepData.postId && prepData.zipUploadUrl && prepData.zipKey);

  const zip = new JSZip();
  zip.file('index.html', '<!doctype html><html><body>game</body></html>');
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
  const upload = await fetch(prepData.zipUploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip', Cookie: cookie },
    body: bytes,
  });
  assert.equal(upload.status, 200);

  const commit = await fetch(`${BASE_URL}/api/posts/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ postId: prepData.postId, zipKey: prepData.zipKey, text: 'my game' }),
  });
  assert.equal(commit.status, 200);
  return prepData.postId;
}

async function createTextPost(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text: 'Not a game' }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { id: string }).id;
}

function gameTitle(postId: string, titleId: string) {
  return {
    postId,
    titleId,
    name: 'Level 1 Clear',
    nameJa: 'レベル1クリア',
    description: 'Cleared the first level.',
    descriptionJa: '最初のレベルをクリアした。',
    icon: '/icons/badge-96.png',
  };
}

async function authorTitle(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}/api/titles/game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function awardTitle(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}/api/titles/game/award`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function ownedTitleIds(cookie: string): Promise<{ ids: string[]; equipped: string | null }> {
  const res = await fetch(`${BASE_URL}/api/titles/me`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { titles: Array<{ id: string }>; equipped_title_id: string | null };
  return { ids: data.titles.map((title) => title.id), equipped: data.equipped_title_id };
}

async function catalogHas(titleId: string): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/api/titles`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as { titles: Array<{ id: string }> };
  return data.titles.some((title) => title.id === titleId);
}

describe('game titles', () => {
  beforeEach(resetDb);

  it('requires authentication', async () => {
    const body = gameTitle('post1', 'game.level1');
    const authored = await fetch(`${BASE_URL}/api/titles/game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(authored.status, 401);

    const awarded = await fetch(`${BASE_URL}/api/titles/game/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(awarded.status, 401);
  });

  it('lets the game author create a title exactly once', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createGamePost(cookie);
    const body = gameTitle(postId, 'game.level1');

    const created = await authorTitle(cookie, body);
    assert.equal(created.status, 201);
    const createdData = (await created.json()) as {
      created: boolean;
      title: { id: string; name: string; game_post_id?: string };
    };
    assert.equal(createdData.created, true);
    assert.equal(createdData.title.id, 'game.level1');
    assert.equal(createdData.title.name, 'Level 1 Clear');
    assert.equal(createdData.title.game_post_id, undefined);
    assert.ok(await catalogHas('game.level1'));

    const again = await authorTitle(cookie, body);
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { created: boolean }).created, false);
  });

  it('rejects title creation by anyone other than the game author', async () => {
    const author = await seedUserAndLogin('1');
    const other = await seedUserAndLogin('2');
    const postId = await createGamePost(author.cookie);

    const res = await authorTitle(other.cookie, gameTitle(postId, 'game.level1'));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code?: string }).code, 'FORBIDDEN');
    assert.equal(await catalogHas('game.level1'), false);
  });

  it('rejects titles for non-game posts', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createTextPost(cookie);

    const res = await authorTitle(cookie, gameTitle(postId, 'game.level1'));
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, 'POST_NOT_FOUND');
  });

  it('lets a player award an authored title and equip it', async () => {
    const author = await seedUserAndLogin('1');
    const player = await seedUserAndLogin('2');
    const postId = await createGamePost(author.cookie);
    const body = gameTitle(postId, 'game.level1');
    assert.equal((await authorTitle(author.cookie, body)).status, 201);

    const awarded = await awardTitle(player.cookie, body);
    assert.equal(awarded.status, 200);
    assert.equal(((await awarded.json()) as { awarded: boolean }).awarded, true);
    assert.ok((await ownedTitleIds(player.cookie)).ids.includes('game.level1'));

    const equipped = await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: player.cookie },
      body: JSON.stringify({ titleId: 'game.level1' }),
    });
    assert.equal(equipped.status, 200);
    assert.equal((await ownedTitleIds(player.cookie)).equipped, 'game.level1');
  });

  it('awards idempotently and rejects unregistered titles', async () => {
    const author = await seedUserAndLogin('1');
    const player = await seedUserAndLogin('2');
    const postId = await createGamePost(author.cookie);
    const body = gameTitle(postId, 'game.level1');

    const missing = await awardTitle(player.cookie, body);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code?: string }).code, 'TITLE_NOT_FOUND');

    assert.equal((await authorTitle(author.cookie, body)).status, 201);
    assert.equal((await awardTitle(player.cookie, body)).status, 200);
    assert.equal((await awardTitle(player.cookie, body)).status, 200);
    assert.ok((await ownedTitleIds(player.cookie)).ids.includes('game.level1'));
  });

  it("refuses another game's title and platform titles", async () => {
    const author = await seedUserAndLogin('1');
    const player = await seedUserAndLogin('2');
    const firstGame = await createGamePost(author.cookie);
    const secondGame = await createGamePost(author.cookie);
    assert.equal((await authorTitle(author.cookie, gameTitle(firstGame, 'game.one'))).status, 201);

    const stolen = await awardTitle(player.cookie, gameTitle(secondGame, 'game.one'));
    assert.equal(stolen.status, 409);
    assert.equal(((await stolen.json()) as { code?: string }).code, 'TITLE_CONFLICT');

    const stolenCatalog = await authorTitle(author.cookie, gameTitle(secondGame, 'game.one'));
    assert.equal(stolenCatalog.status, 409);

    const shadow = await authorTitle(author.cookie, gameTitle(firstGame, 'flaxian_newcomer'));
    assert.equal(shadow.status, 409);
    assert.equal(((await shadow.json()) as { code?: string }).code, 'TITLE_CONFLICT');
  });

  it('rejects non-image and absolute icons', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createGamePost(cookie);

    for (const icon of ['https://tracker.example/pixel.png', '//tracker.example/pixel.png', 'not-a-path']) {
      const res = await authorTitle(cookie, { ...gameTitle(postId, 'game.icon'), icon });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { code?: string }).code, 'INVALID_TITLE');
    }
  });

  it('rejects unknown posts and caps ids/display text', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createGamePost(cookie);

    const unknown = await authorTitle(cookie, gameTitle('does_not_exist', 'game.level1'));
    assert.equal(unknown.status, 404);

    const longName = await authorTitle(cookie, { ...gameTitle(postId, 'game.level1'), name: 'a'.repeat(65) });
    assert.equal(longName.status, 400);

    const longId = await authorTitle(cookie, gameTitle(postId, `a.${'b'.repeat(127)}`));
    assert.equal(longId.status, 400);

    const blankName = await authorTitle(cookie, { ...gameTitle(postId, 'game.level1'), name: '   ' });
    assert.equal(blankName.status, 400);
  });

  it('removes game titles when the game post is deleted', async () => {
    const author = await seedUserAndLogin('1');
    const player = await seedUserAndLogin('2');
    const postId = await createGamePost(author.cookie);
    const body = gameTitle(postId, 'game.level1');
    assert.equal((await authorTitle(author.cookie, body)).status, 201);
    assert.equal((await awardTitle(player.cookie, body)).status, 200);

    const equipped = await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: player.cookie },
      body: JSON.stringify({ titleId: 'game.level1' }),
    });
    assert.equal(equipped.status, 200);

    const deleted = await fetch(`${BASE_URL}/api/posts/${postId}`, {
      method: 'DELETE',
      headers: { Cookie: author.cookie },
    });
    assert.equal(deleted.status, 200);

    assert.equal(await catalogHas('game.level1'), false);
    const owned = await ownedTitleIds(player.cookie);
    assert.equal(owned.ids.includes('game.level1'), false);
    assert.equal(owned.equipped, null);
  });
});
