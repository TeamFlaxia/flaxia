// SSR/SEO behaviour for the remote profile route `/@domain/user`.
//
// The route owns its metadata (the root layout suppresses its generic tags),
// must not be cached because follow state is viewer-specific, and must never
// inject untrusted actor HTML into a script element. These are checked against
// real SSR output from the compiled route/layout and the exported pure load
// and summary helpers, not against source-text regexes.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { render } from 'svelte/server';
import { createServer, type ViteDevServer } from 'vite';
import { resolveActorInbox } from '../functions/lib/activitypub/delivery.ts';
import { normalizeActorSummary } from '../functions/lib/activitypub/fetch.ts';
import { handleIncomingActivity } from '../functions/lib/activitypub/handlers.ts';
import { pageTitle } from '../src/lib/page-title.ts';
import { loadRemoteProfile } from '../src/lib/ssr-data.ts';
import { createTestDatabase, type TestDatabase } from './helpers/d1.ts';

// Route modules use extensionless relative imports for the Worker bundler.
register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
      return nextResolve(specifier + '.ts', context);
    }
    throw error;
  }
}
`),
);

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

// --- Real Svelte SSR -------------------------------------------------------

const appStub = {
  name: 'app-state-stub',
  enforce: 'pre' as const,
  resolveId(id: string) {
    return id.startsWith('$app/') ? `\0stub:${id}` : null;
  },
  load(id: string) {
    if (!id.startsWith('\0stub:')) return null;
    const module = id.slice(6);
    if (module === '$app/navigation') {
      return `export const goto = async () => {}; export const preloadCode = async () => {}; export const preloadData = async () => {}; export const beforeNavigate = () => {}; export const afterNavigate = () => {};`;
    }
    if (module === '$app/state') {
      return `export const page = new Proxy({}, { get: (_, key) => globalThis.__PAGE__?.[key] });`;
    }
    return `export default {};`;
  },
};

const ROOT = resolve(new URL('..', import.meta.url).pathname);
let server: ViteDevServer;
let routeLoad: (args: Record<string, unknown>) => Promise<{ profile?: unknown }>;
let routePage: unknown;
let layout: unknown;

before(async () => {
  server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    plugins: [appStub, svelte({ compilerOptions: { dev: false } })],
    resolve: { conditions: ['node'] },
  });
  routeLoad = ((await server.ssrLoadModule('/src/routes/@[domain]/[username]/+page.ts')) as { load: typeof routeLoad })
    .load;
  routePage = (await server.ssrLoadModule('/src/routes/@[domain]/[username]/+page.svelte')).default;
  layout = (await server.ssrLoadModule('/src/routes/+layout.svelte')).default;
});

after(async () => {
  await server.close();
});

function pageState(routeId: string, pathname: string, params: Record<string, string> = {}): void {
  (globalThis as unknown as { __PAGE__: unknown }).__PAGE__ = {
    status: 200,
    params,
    data: {},
    route: { id: routeId },
    url: new URL(`https://flaxia.app${pathname}`),
  };
}

const PROFILE = {
  actor: {
    actor_url: 'https://remote.example/users/bob',
    display_name: 'Bob',
    icon_url: 'https://remote.example/icon.png',
    bio: 'A bio with </script><script>alert(1)</script> markup',
  },
  following: true,
  posts: [{ id: 'p1', text: 'first remote post' }],
};

function renderProfile(data: { profile: typeof PROFILE | null }): { head: string; body: string } {
  pageState('/@[domain]/[username]', '/@remote.example/bob', { domain: 'remote.example', username: 'bob' });
  const result = render(routePage as never, { props: { data } });
  return { head: result.head, body: result.body };
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
  const databases: TestDatabase[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    db = createTestDatabase();
    databases.push(db);
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
    for (const database of databases) database.close();
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

  it('stores a clamped 500-character bio from a fetched actor document', async () => {
    db.prepare('DELETE FROM ap_actors').run();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: actorUrl,
          type: 'Person',
          preferredUsername: 'bob',
          name: 'Bob',
          summary: `<p>${'y'.repeat(900)}</p>`,
          inbox: `${actorUrl}/inbox`,
          publicKey: { id: `${actorUrl}#main-key`, owner: actorUrl, publicKeyPem: '-----BEGIN PUBLIC KEY-----' },
        }),
        { headers: { 'content-type': 'application/activity+json' } },
      )) as typeof fetch;
    await resolveActorInbox({ DB: db as unknown as D1Database, BASE_URL: baseUrl }, actorUrl);
    assert.equal((await storedSummary())?.length, 500);
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

describe('remote profile universal load', () => {
  it('sets a private no-store header and returns the profile', async () => {
    const headers: Array<Record<string, string>> = [];
    const profile = await routeLoad({
      fetch: jsonFetch(200, PROFILE),
      params: { domain: 'remote.example', username: 'bob' },
      setHeaders: (values: Record<string, string>) => headers.push(values),
    });
    assert.deepEqual(headers, [{ 'Cache-Control': 'private, no-store' }]);
    assert.deepEqual(profile, { profile: PROFILE });
  });

  it('404s malformed handles before making any request', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify(PROFILE), { status: 200 });
    }) as typeof fetch;
    for (const params of [
      { domain: 'bad_domain', username: 'bob' },
      { domain: 'remote.example', username: 'bad/name' },
      { domain: 'a'.repeat(254), username: 'bob' },
    ]) {
      await assert.rejects(
        routeLoad({ fetch: fetchFn, params, setHeaders: () => {} }),
        (error: unknown) => (error as { status?: number }).status === 404,
        JSON.stringify(params),
      );
    }
    assert.equal(calls, 0);
  });

  it('404s a missing remote actor', async () => {
    await assert.rejects(
      routeLoad({
        fetch: jsonFetch(404, { error: 'not found' }),
        params: { domain: 'remote.example', username: 'nobody' },
        setHeaders: () => {},
      }),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
  });
});

describe('remote profile SSR output', () => {
  it('owns its title, canonical and Open Graph URLs', () => {
    const { head } = renderProfile({ profile: PROFILE });
    assert.match(head, /<title>Flaxia - remote_profile\.title · @bob@remote\.example<\/title>/);
    assert.match(head, /<link rel="canonical" href="https:\/\/flaxia\.app\/@remote\.example\/bob"\/>/);
    assert.match(head, /property="og:url" content="https:\/\/flaxia\.app\/@remote\.example\/bob"/);
    assert.match(head, /content="https:\/\/remote\.example\/icon\.png"/, 'a safe actor icon is the og:image');
    assert.match(head, /name="description" content="A bio with /);
  });

  it('clamps the meta description to a 160-character bio excerpt', () => {
    const bio = `${'a'.repeat(200)} tail`;
    const { head } = renderProfile({
      profile: { ...PROFILE, actor: { ...PROFILE.actor, bio } },
    });
    assert.match(head, new RegExp(`name="description" content="${'a'.repeat(160)}"`));
  });

  it('emits an escaped Person JSON-LD block, never inline script markup', () => {
    const { head } = renderProfile({ profile: PROFILE });
    const blocks = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1, 'only the JSON-LD script may appear in the head');
    const json = blocks[0][1];
    assert.ok(!json.includes('</script>'), 'untrusted bio markup must be escaped inside JSON-LD');
    const person = JSON.parse(json) as Record<string, unknown>;
    assert.equal(person['@type'], 'Person');
    assert.equal(person.name, 'Bob');
    assert.equal(person.alternateName, '@bob@remote.example');
    assert.equal(person.url, 'https://flaxia.app/@remote.example/bob');
    assert.equal(person.description, PROFILE.actor.bio);
  });

  it('renders the SSR fallback with the actor, bio and posts', () => {
    const { body } = renderProfile({ profile: PROFILE });
    assert.match(body, /class="ssr-remote-profile"/);
    assert.match(body, /@bob@remote\.example/);
    assert.match(body, /A bio with &lt;\/script>&lt;script>alert\(1\)&lt;\/script>/);
    assert.match(body, /first remote post/);
  });

  it('keeps the SPA title instance-aware and local profiles unchanged', () => {
    assert.equal(pageTitle('/@remote.example/alice'), 'Flaxia - remote_profile.title · @alice@remote.example');
    assert.equal(pageTitle('/profile/alice'), 'Flaxia - nav.profile · @alice');
  });
});

describe('root layout metadata', () => {
  function layoutHead(routeId: string, pathname: string): string {
    pageState(routeId, pathname);
    return render(layout as never, { props: { children: () => 'children' } }).head;
  }

  it('suppresses every generic metadata tag on the remote profile route', () => {
    const head = layoutHead('/@[domain]/[username]', '/@remote.example/bob');
    assert.ok(!head.includes('application/ld+json'), 'no generic WebSite JSON-LD');
    assert.ok(!head.includes('<title>'), 'no generic document title');
    assert.ok(!head.toLowerCase().includes('og:description'), 'no generic description');
  });

  it('still emits generic WebSite metadata on ordinary routes', () => {
    const head = layoutHead('/home', '/home');
    assert.match(head, /application\/ld\+json/);
    assert.match(head, /<title>/);
  });
});
