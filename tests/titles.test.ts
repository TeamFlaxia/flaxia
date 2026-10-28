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

async function grantTitle(username: string, titleId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/grant-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, titleId }),
  });
  assert.equal(res.status, 201);
}

describe('user titles', () => {
  beforeEach(resetDb);

  it('lists only titles the user owns', async () => {
    const { cookie } = await seedUserAndLogin('1');

    const empty = await fetch(`${BASE_URL}/api/titles/me`, { headers: { Cookie: cookie } });
    assert.equal(empty.status, 200);
    assert.deepEqual(((await empty.json()) as { titles: Title[] }).titles, []);

    await grantTitle('testuser1', 'arcade_first_clear');

    const res = await fetch(`${BASE_URL}/api/titles/me`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { titles: Title[]; equipped_title_id: string | null };
    assert.equal(data.titles.length, 1);
    assert.equal(data.titles[0]?.id, 'arcade_first_clear');
    assert.equal(data.equipped_title_id, null);
  });

  it('equips an owned title and exposes it on the profile', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await grantTitle('testuser1', 'arcade_first_clear');

    const equip = await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: 'arcade_first_clear' }),
    });
    assert.equal(equip.status, 200);

    const profile = await fetch(`${BASE_URL}/api/users/testuser1`);
    const body = (await profile.json()) as {
      user: { equipped_title_id: string; title_name: string; title_icon: string };
    };
    assert.equal(body.user.equipped_title_id, 'arcade_first_clear');
    assert.equal(body.user.title_name, 'First Clear');
    assert.equal(body.user.title_icon, '🎮');
  });

  it('equips a title through the multipart profile editor', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await grantTitle('testuser1', 'arcade_first_clear');

    const form = new FormData();
    form.append('display_name', 'Test User');
    form.append('bio', '');
    form.append('equipped_title_id', 'arcade_first_clear');

    const res = await fetch(`${BASE_URL}/api/users/me`, {
      method: 'PATCH',
      headers: { Cookie: cookie },
      body: form,
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { user: { equipped_title_id: string; title_name: string } };
    assert.equal(data.user.equipped_title_id, 'arcade_first_clear');
    assert.equal(data.user.title_name, 'First Clear');
  });

  it('rejects equipping a title the user does not own', async () => {
    const { cookie } = await seedUserAndLogin('1');

    const res = await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: 'arcade_legend' }),
    });
    assert.equal(res.status, 403);
  });

  it('includes the equipped title in post author data', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await grantTitle('testuser1', 'arcade_first_clear');

    await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: 'arcade_first_clear' }),
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
    assert.equal(post.title_name, 'First Clear');
    assert.equal(post.title_icon, '🎮');
  });

  it('clears the equipped title with null', async () => {
    const { cookie } = await seedUserAndLogin('1');
    await grantTitle('testuser1', 'arcade_first_clear');

    await fetch(`${BASE_URL}/api/titles/me/equipped`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ titleId: 'arcade_first_clear' }),
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
