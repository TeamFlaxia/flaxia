import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

/**
 * Game-authored titles (称号). These exercise the server contract behind the
 * Game API's CREATE_TITLE / AWARD_TITLE frames: a game may only author and
 * grant titles scoped to the post it is running, never a platform title and
 * never another game's achievement.
 */

async function createGamePost(cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text: 'Game post' }),
  });
  assert.equal(res.status, 201);
  const data = (await res.json()) as { id: string };
  return data.id;
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

  it('authors a title for a game post exactly once', async () => {
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

    const catalog = await fetch(`${BASE_URL}/api/titles`);
    assert.equal(catalog.status, 200);
    const catalogData = (await catalog.json()) as { titles: Array<{ id: string }> };
    assert.ok(catalogData.titles.some((title) => title.id === 'game.level1'));

    const again = await authorTitle(cookie, body);
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { created: boolean }).created, false);
  });

  it('awards a game title to the caller and lets them equip it', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createGamePost(cookie);

    const awarded = await awardTitle(cookie, gameTitle(postId, 'game.level1'));
    assert.equal(awarded.status, 200);
    assert.equal(((await awarded.json()) as { awarded: boolean }).awarded, true);

    assert.ok((await ownedTitleIds(cookie)).ids.includes('game.level1'));

    const equipped = await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: 'game.level1' }),
    });
    assert.equal(equipped.status, 200);
    assert.equal((await ownedTitleIds(cookie)).equipped, 'game.level1');
  });

  it('awards idempotently', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createGamePost(cookie);

    assert.equal((await awardTitle(cookie, gameTitle(postId, 'game.level1'))).status, 200);
    assert.equal((await awardTitle(cookie, gameTitle(postId, 'game.level1'))).status, 200);
    assert.ok((await ownedTitleIds(cookie)).ids.includes('game.level1'));
  });

  it("refuses another game's title", async () => {
    const { cookie } = await seedUserAndLogin('1');
    const firstGame = await createGamePost(cookie);
    const secondGame = await createGamePost(cookie);

    assert.equal((await awardTitle(cookie, gameTitle(firstGame, 'game.one'))).status, 200);

    const stolen = await awardTitle(cookie, gameTitle(secondGame, 'game.one'));
    assert.equal(stolen.status, 409);
    assert.equal(((await stolen.json()) as { code?: string }).code, 'TITLE_CONFLICT');

    const stolenCatalog = await authorTitle(cookie, gameTitle(secondGame, 'game.one'));
    assert.equal(stolenCatalog.status, 409);
  });

  it('refuses to shadow a platform title', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createGamePost(cookie);

    const shadow = await awardTitle(cookie, gameTitle(postId, 'flaxian_newcomer'));
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

  it('rejects unknown posts', async () => {
    const { cookie } = await seedUserAndLogin('1');

    const res = await authorTitle(cookie, gameTitle('does_not_exist', 'game.level1'));
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code?: string }).code, 'POST_NOT_FOUND');
  });

  it('caps ids and display text', async () => {
    const { cookie } = await seedUserAndLogin('1');
    const postId = await createGamePost(cookie);

    const longName = await authorTitle(cookie, { ...gameTitle(postId, 'game.level1'), name: 'a'.repeat(65) });
    assert.equal(longName.status, 400);

    const longId = await authorTitle(cookie, gameTitle(postId, `a.${'b'.repeat(127)}`));
    assert.equal(longId.status, 400);

    const blankName = await authorTitle(cookie, { ...gameTitle(postId, 'game.level1'), name: '   ' });
    assert.equal(blankName.status, 400);
  });
});
