// SSR/SEO guards for the remote profile route `/@domain/user`.
//
// The route must own its metadata (the root layout suppresses its generic tags
// for it), must not be cached because follow state is viewer-specific, and must
// never inject untrusted actor HTML into a script element.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { resolveActorInbox } from '../functions/lib/activitypub/delivery.ts';
import { normalizeActorSummary } from '../functions/lib/activitypub/fetch.ts';
import { handleIncomingActivity } from '../functions/lib/activitypub/handlers.ts';
import { loadRemoteProfile } from '../src/lib/ssr-data.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

describe('loadRemoteProfile', () => {
  it('returns null for a missing actor', async () => {
    assert.equal(await loadRemoteProfile(jsonFetch(404, { error: 'not found' }), 'remote.example', 'bob'), null);
    assert.equal(await loadRemoteProfile(jsonFetch(200, {}), 'remote.example', 'bob'), null);
  });

  it('surfaces upstream failures instead of reporting a false 404', async () => {
    await assert.rejects(loadRemoteProfile(jsonFetch(503, {}), 'remote.example', 'bob'), /503/);
    await assert.rejects(loadRemoteProfile(jsonFetch(500, {}), 'remote.example', 'bob'), /500/);
  });

  it('passes the profile payload through and encodes the handle', async () => {
    const actor = { actor_url: 'https://remote.example/users/bob', bio: 'plain text', display_name: 'Bob' };
    const profile = { actor, following: true, posts: [{ id: 'p1', text: 'hello' }] };
    let requested = '';
    const fetchFn = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(JSON.stringify(profile), { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await loadRemoteProfile(fetchFn, 'remote.example', 'bob'), profile);
    assert.equal(requested, '/api/remote/actors/remote.example/bob');
  });
});

describe('normalizeActorSummary', () => {
  it('converts untrusted HTML into escaped plain text', () => {
    assert.equal(
      normalizeActorSummary('<p>Hello <b>world</b><script>alert(1)</script>&amp; friends</p>'),
      'Hello world & friends',
    );
    assert.equal(normalizeActorSummary('plain text'), 'plain text');
  });

  it('clamps the bio and rejects non-strings or empty markup', () => {
    const long = normalizeActorSummary(`<p>${'x'.repeat(900)}</p>`);
    assert.equal(long?.length, 500);
    assert.equal(normalizeActorSummary(null), null);
    assert.equal(normalizeActorSummary({ en: '<p>hello</p>' }), null);
    assert.equal(normalizeActorSummary('<script>alert(1)</script>'), null);
  });
});

describe('remote actor summary persistence', () => {
  const actorUrl = 'https://remote.example/users/bob';
  const baseUrl = 'https://flaxia.app';
  let db: TestDatabase;
  const originalFetch = globalThis.fetch;

  before(async () => {
    db = createTestDatabase();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: actorUrl,
          type: 'Person',
          preferredUsername: 'bob',
          name: 'Bob',
          summary: '<p>Hello <b>world</b></p>',
          inbox: `${actorUrl}/inbox`,
          publicKey: { id: `${actorUrl}#main-key`, owner: actorUrl, publicKeyPem: '-----BEGIN PUBLIC KEY-----' },
        }),
        { headers: { 'content-type': 'application/activity+json' } },
      )) as typeof fetch;
    await resolveActorInbox({ DB: db as unknown as D1Database, BASE_URL: baseUrl }, actorUrl);
  });

  after(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  async function storedSummary(): Promise<string | null> {
    const row = await db
      .prepare('SELECT summary FROM ap_actors WHERE actor_url = ?')
      .bind(actorUrl)
      .first<{ summary: string | null }>();
    return row?.summary ?? null;
  }

  it('stores the normalised summary on the delivery cache path', async () => {
    assert.equal(await storedSummary(), 'Hello world');
  });

  it('propagates an Update summary but keeps it on a partial Update', async () => {
    const env = { DB: db as unknown as D1Database, BASE_URL: baseUrl };
    await handleIncomingActivity(env, {
      actorId: actorUrl,
      username: 'alice',
      activity: {
        id: 'https://remote.example/activities/update-1',
        type: 'Update',
        actor: actorUrl,
        object: {
          id: actorUrl,
          type: 'Person',
          attributedTo: actorUrl,
          name: 'Bob',
          preferredUsername: 'bob',
          summary: '<p>New bio</p>',
        },
      },
    });
    assert.equal(await storedSummary(), 'New bio');

    await handleIncomingActivity(env, {
      actorId: actorUrl,
      username: 'alice',
      activity: {
        id: 'https://remote.example/activities/update-2',
        type: 'Update',
        actor: actorUrl,
        object: { id: actorUrl, type: 'Person', attributedTo: actorUrl, name: 'Renamed' },
      },
    });
    assert.equal(await storedSummary(), 'New bio');
  });
});

describe('remote profile route source', () => {
  it('uses a non-cacheable universal load with validated params and a 404', async () => {
    const load = await read('src/routes/@[domain]/[username]/+page.ts');
    assert.match(load, /loadRemoteProfile\(/);
    assert.match(load, /Cache-Control': 'private, no-store'/);
    assert.match(load, /import\.meta\.env\.BUILD_TARGET === 'native'/);
    assert.match(load, /DOMAIN_PATTERN\.test/);
    assert.match(load, /USERNAME_PATTERN\.test/);
    assert.match(load, /throw error\(404,/);
    assert.match(load, /return \{ profile \}/);
  });

  it('renders its own SEO head with a safe Person ld+json block', async () => {
    const page = await read('src/routes/@[domain]/[username]/+page.svelte');
    assert.match(page, /<svelte:head>/);
    assert.match(page, /<title>\{metaTitle\}<\/title>/);
    assert.match(page, /t\('remote_profile\.title'\)/);
    assert.match(page, /handle/);
    assert.match(page, /bio\.slice\(0, 160\)/);
    assert.match(page, /SEO_ORIGIN\}\/@\$\{encodeURIComponent\(domain\)\}/);
    assert.match(page, /renderPersonJsonLd\(/);
    assert.match(page, /\{@html jsonLd\}/);
    const head = page.match(/<svelte:head>([\s\S]*?)<\/svelte:head>/)?.[1];
    assert.ok(head, 'the route must have a svelte:head block');
    assert.doesNotMatch(head, /<script\b/i, 'JSON-LD must go through the escaping helper, not an inline script');
    assert.match(page, /<link rel="canonical" href=\{canonicalUrl\} \/>/);
    assert.match(page, /property="og:url"/);
    assert.match(page, /SsrOnly/);
    assert.match(page, /initialProfile=\{data\.profile\}/);
  });

  it('reads the session only after mount', async () => {
    const page = await read('src/routes/@[domain]/[username]/+page.svelte');
    assert.match(page, /onMount\(\(\) => \{\s*currentUser = getSessionUser\(\)/);
  });

  it('is excluded from every generic layout metadata set', async () => {
    const layout = await read('src/routes/+layout.svelte');
    const route = "'/@[domain]/[username]'";
    for (const setName of ['OWN_META_ROUTES', 'OWN_TITLE_ROUTES', 'SELF_TITLE_TAG_ROUTES']) {
      const block = layout.match(new RegExp(`const ${setName}[\\s\\S]*?\\]\\);`))?.[0];
      assert.ok(block, `${setName} must exist`);
      assert.ok(block.includes(route), `${setName} must include the remote profile route`);
    }
  });

  it('includes the instance in the SPA document title', async () => {
    const titles = await read('src/lib/page-title.ts');
    assert.ok(titles.includes('pathname.match(/^\\/@([^/]+)\\/([^/]+)/)'), 'remote handle must capture the domain');
    assert.match(titles, /remote_profile\.title/);
    assert.match(
      titles,
      /@\$\{decodeURIComponent\(remote\[2\]\)\}@\$\{decodeURIComponent\(remote\[1\]\)\}/,
      'the title must include both the username and the instance',
    );
    assert.ok(
      titles.includes('pathname.match(/^\\/(?:profile|users)\\/([^/]+)/)'),
      'local profile titles are unchanged',
    );
  });

  it('stores a clamped bio column and caches it on every actor upsert', async () => {
    const migration = await read('migrations/0148_ap_actor_summary.sql');
    assert.match(migration, /ALTER TABLE ap_actors ADD COLUMN summary TEXT;/);

    const fetchSource = await read('functions/lib/activitypub/fetch.ts');
    assert.match(fetchSource, /htmlToText\(value\)\.slice\(0, MAX_ACTOR_SUMMARY_LENGTH\)/);
    assert.match(fetchSource, /summary: string \| null/);
    assert.match(fetchSource, /summary: normalizeActorSummary\(document\.summary\)/);

    for (const file of ['functions/lib/activitypub/delivery.ts', 'functions/lib/activitypub/handlers.ts']) {
      const source = await read(file);
      assert.match(source, /INSERT INTO ap_actors \([^)]*summary, fetched_at\)/, `${file} must insert summary`);
      assert.match(source, /summary = excluded\.summary/, `${file} must refresh summary on conflict`);
      assert.match(source, /actor\.summary,/, `${file} must bind the normalised summary`);
    }

    const handlers = await read('functions/lib/activitypub/handlers.ts');
    assert.match(handlers, /normalizeActorSummary\(object\.summary\)/);
    assert.match(handlers, /summary = CASE WHEN \? = 1 THEN \? ELSE summary END/);
  });
});
