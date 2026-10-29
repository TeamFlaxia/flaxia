import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

type Title = {
  id: string;
  icon: string;
  name: string;
  name_ja: string;
  description: string;
  equipped?: boolean;
};

const NEWCOMER_TITLE = {
  id: 'flaxian_newcomer',
  icon: '/icons/flaxian.png',
  name: 'Budding Flaxian',
  name_ja: '駆け出しのFlaxian',
  description: 'Created a Flaxia account.',
  description_ja: 'Flaxiaにアカウント作成をした。',
  sort_order: 0,
} as const;

const FIRST_CLEAR = {
  id: 'test_first_clear',
  icon: '🧪',
  name: 'Test Clear',
  name_ja: 'テストクリア',
  description: 'Test fixture title.',
  description_ja: 'テスト用の称号です。',
  sort_order: 1,
} as const;

const OTHER_TITLE = {
  id: 'test_other',
  icon: '🧪',
  name: 'Other Title',
  name_ja: '別の称号',
  description: 'Another test fixture title.',
  description_ja: 'もうひとつのテスト用称号です。',
  sort_order: 2,
} as const;

async function createTitle(title: typeof NEWCOMER_TITLE | typeof FIRST_CLEAR | typeof OTHER_TITLE): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title),
  });
  assert.equal(res.status, 201);
}

async function grantTitle(username: string, titleId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/grant-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, titleId }),
  });
  assert.equal(res.status, 201);
}

describe('user titles', () => {
  beforeEach(async () => {
    await resetDb();
    await createTitle(NEWCOMER_TITLE);
    await createTitle(FIRST_CLEAR);
    await createTitle(OTHER_TITLE);
  });

  it('awards the newcomer title on registration and lists only owned titles', async () => {
    const { cookie } = await seedUserAndLogin('1');

    const initial = await fetch(`${BASE_URL}/api/titles/me`, { headers: { Cookie: cookie } });
    assert.equal(initial.status, 200);
    const initialData = (await initial.json()) as { titles: Title[]; equipped_title_id: string | null };
    assert.deepEqual(
      initialData.titles.map((title) => title.id),
      [NEWCOMER_TITLE.id],
    );
    assert.equal(initialData.titles[0]?.icon, NEWCOMER_TITLE.icon);
    assert.equal(initialData.equipped_title_id, null);

    await grantTitle('testuser1', FIRST_CLEAR.id);

    const res = await fetch(`${BASE_URL}/api/titles/me`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { titles: Title[]; equipped_title_id: string | null };
    assert.deepEqual(data.titles.map((title) => title.id).sort(), [NEWCOMER_TITLE.id, FIRST_CLEAR.id].sort());
    assert.equal(data.equipped_title_id, null);
  });

  it('equips an owned title and exposes it on the profile', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await grantTitle('testuser1', FIRST_CLEAR.id);

    const equip = await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: FIRST_CLEAR.id }),
    });
    assert.equal(equip.status, 200);

    const profile = await fetch(`${BASE_URL}/api/users/testuser1`);
    const body = (await profile.json()) as {
      user: { equipped_title_id: string; title_name: string; title_icon: string };
    };
    assert.equal(body.user.equipped_title_id, FIRST_CLEAR.id);
    assert.equal(body.user.title_name, FIRST_CLEAR.name);
    assert.equal(body.user.title_icon, FIRST_CLEAR.icon);
  });

  it('equips a title through the multipart profile editor', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await grantTitle('testuser1', FIRST_CLEAR.id);

    const form = new FormData();
    form.append('display_name', 'Test User');
    form.append('bio', '');
    form.append('equipped_title_id', FIRST_CLEAR.id);

    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: { Cookie: cookie },
      body: form,
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { user: { equipped_title_id: string; title_name: string } };
    assert.equal(data.user.equipped_title_id, FIRST_CLEAR.id);
    assert.equal(data.user.title_name, FIRST_CLEAR.name);
  });

  it('rejects equipping a title the user does not own', async () => {
    const { cookie } = await seedUserAndLogin('1');

    const res = await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: OTHER_TITLE.id }),
    });
    assert.equal(res.status, 403);
  });

  it('includes the equipped title in post author data', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await grantTitle('testuser1', FIRST_CLEAR.id);

    await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: FIRST_CLEAR.id }),
    });
    await fetch(`${BASE_URL}/api/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ text: 'Title join check' }),
    });

    const res = await fetch(`${BASE_URL}/api/posts?limit=10`);
    const data = (await res.json()) as {
      posts: Array<{ username: string; title_name: string; title_icon: string }>;
    };
    const post = data.posts.find((p) => p.username === 'testuser1');
    assert.ok(post);
    assert.equal(post.title_name, FIRST_CLEAR.name);
    assert.equal(post.title_icon, FIRST_CLEAR.icon);
  });

  it('clears the equipped title with null', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await grantTitle('testuser1', FIRST_CLEAR.id);

    await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: FIRST_CLEAR.id }),
    });
    const clear = await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: null }),
    });
    assert.equal(clear.status, 200);

    const profile = await fetch(`${BASE_URL}/api/users/testuser1`);
    const body = (await profile.json()) as { user: { equipped_title_id: string | null } };
    assert.equal(body.user.equipped_title_id, null);
  });
});
