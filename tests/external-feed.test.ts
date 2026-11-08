import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { parseArxivAtom, parseHackerNewsAlgolia } from '../functions/lib/external-feed.ts';
import { computeExternalScore } from '../functions/lib/scoring.ts';
import { BASE_URL, resetDb, seedUserAndLogin } from './helpers/setup.ts';

async function seedExternalItem(item: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/external-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  assert.equal(res.status, 201, 'seed external item');
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

describe('external feed parsers', () => {
  it('parses arXiv Atom entries', () => {
    const xml = `<feed><entry><id>http://arxiv.org/abs/2601.00001v2</id><title> A  Title </title><summary>Abstract text</summary><published>2026-01-01T00:00:00Z</published><author><name>Jane Doe</name></author><link rel="alternate" href="https://arxiv.org/abs/2601.00001"/><category term="cs.AI"/></entry></feed>`;
    const items = parseArxivAtom(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].externalId, '2601.00001');
    assert.equal(items[0].title, 'A Title');
    assert.equal(items[0].url, 'https://arxiv.org/abs/2601.00001');
    assert.deepEqual(items[0].tags, ['cs.AI']);
    assert.equal(items[0].author, 'Jane Doe');
  });

  it('parses HN Algolia hits and falls back for missing url', () => {
    const items = parseHackerNewsAlgolia({
      hits: [
        {
          objectID: '123',
          title: 'Story',
          url: 'https://example.com',
          author: 'pg',
          created_at: '2026-01-01T00:00:00Z',
          _tags: ['story'],
        },
        { objectID: '124', title: 'Ask HN', url: null, author: 'sam', created_at: '2026-01-02T00:00:00Z' },
      ],
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].url, 'https://example.com');
    assert.equal(items[1].url, 'https://news.ycombinator.com/item?id=124');
    assert.deepEqual(parseHackerNewsAlgolia({}), []);
  });
});

describe('computeExternalScore', () => {
  it('ranks newer items above older items with the same quality', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const newer = computeExternalScore(
      {
        title: 'A solid paper title',
        summary: 'Abstract',
        publishAt: new Date(now - 3600_000).toISOString(),
        source: 'arxiv',
      },
      now,
    );
    const older = computeExternalScore(
      {
        title: 'A solid paper title',
        summary: 'Abstract',
        publishAt: new Date(now - 48 * 3600_000).toISOString(),
        source: 'arxiv',
      },
      now,
    );
    assert.ok(newer > older, `expected ${newer} > ${older}`);
    assert.ok(older > 0);
  });

  it('rewards descriptive titles and summaries', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const publishAt = new Date(now - 3600_000).toISOString();
    const descriptive = computeExternalScore(
      { title: 'A descriptive paper title about widgets', summary: 'Detailed abstract', publishAt, source: 'arxiv' },
      now,
    );
    const terse = computeExternalScore({ title: 'Hi', summary: '', publishAt, source: 'arxiv' }, now);
    assert.ok(descriptive > terse, `expected ${descriptive} > ${terse}`);
  });
});

describe('GET /api/external-feed', () => {
  beforeEach(resetDb);

  it('lists sources', async () => {
    const res = await fetch(`${BASE_URL}/api/external-feed/sources`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { sources: Array<{ source: string; source_label: string }> };
    assert.deepEqual(data.sources.map((s) => s.source).sort(), ['arxiv', 'hackernews']);
  });

  it('returns items ranked by score with the scored fields', async () => {
    await seedExternalItem({
      source: 'arxiv',
      external_id: 'a1',
      title: 'Older paper title',
      summary: 'old summary',
      url: 'https://arxiv.org/abs/a1',
      author: 'Ann',
      tags: ['cs.AI'],
      publish_at: hoursAgoIso(48),
    });
    await seedExternalItem({
      source: 'hackernews',
      external_id: '42',
      title: 'Newer story title',
      summary: '',
      url: 'https://example.com/story',
      author: 'hnuser',
      tags: ['story'],
      publish_at: hoursAgoIso(1),
    });

    const res = await fetch(`${BASE_URL}/api/external-feed?sources=arxiv,hackernews&limit=20`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { items: Array<Record<string, unknown>>; next_cursor: string | null };
    assert.equal(data.items.length, 2);
    assert.equal(data.items[0].title, 'Newer story title');
    assert.equal(data.items[0].source_label, 'Hacker News');
    assert.deepEqual(data.items[0].tags, ['story']);
    assert.ok(Number(data.items[0].score) >= Number(data.items[1].score), 'items must be score-ordered');
    assert.ok(Number(data.items[0].score) > 0, 'items must carry a computed score');
    for (const key of [
      'id',
      'title',
      'summary',
      'url',
      'source',
      'source_label',
      'publish_at',
      'author',
      'tags',
      'score',
    ]) {
      assert.ok(key in data.items[0], `missing ${key}`);
    }
  });

  it('filters by multi-select sources and rejects unknown source', async () => {
    await seedExternalItem({
      source: 'arxiv',
      external_id: 'a1',
      title: 'Paper title',
      url: 'https://arxiv.org/abs/a1',
      publish_at: hoursAgoIso(1),
    });
    await seedExternalItem({
      source: 'hackernews',
      external_id: '42',
      title: 'Story title',
      url: 'https://example.com/story',
      publish_at: hoursAgoIso(2),
    });
    const arxivOnly = await fetch(`${BASE_URL}/api/external-feed?sources=arxiv`);
    assert.equal(arxivOnly.status, 200);
    const arxivData = (await arxivOnly.json()) as { items: Array<{ source: string }> };
    assert.ok(arxivData.items.length >= 1 && arxivData.items.every((i) => i.source === 'arxiv'));
    const bad = await fetch(`${BASE_URL}/api/external-feed?sources=arxiv,rss`);
    assert.equal(bad.status, 400);
    const legacyBad = await fetch(`${BASE_URL}/api/external-feed?source=rss`);
    assert.equal(legacyBad.status, 400);
  });

  it('paginates with score cursor without repeats', async () => {
    for (let i = 0; i < 5; i++) {
      await seedExternalItem({
        source: 'hackernews',
        external_id: `p${i}`,
        title: `Story ${i} title`,
        url: `https://example.com/${i}`,
        publish_at: hoursAgoIso(i + 1),
      });
    }
    const ids: string[] = [];
    const scores: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ sources: 'hackernews', limit: '2' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`${BASE_URL}/api/external-feed?${params}`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as { items: Array<{ id: string; score: number }>; next_cursor: string | null };
      ids.push(...data.items.map((i) => i.id));
      scores.push(...data.items.map((i) => i.score));
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5);
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i - 1] >= scores[i], 'pages must stay score-ordered');
  });

  it('rejects invalid cursor', async () => {
    const res = await fetch(`${BASE_URL}/api/external-feed?sources=arxiv&cursor=bad`);
    assert.equal(res.status, 400);
  });

  it('appears in search external_results', async () => {
    await seedExternalItem({
      source: 'arxiv',
      external_id: 'searchable1',
      title: 'Quantum widgets paper',
      summary: 'About quantum widgets',
      url: 'https://arxiv.org/abs/searchable1',
      author: 'Quinn',
      tags: ['quantum'],
      publish_at: hoursAgoIso(1),
    });
    const res = await fetch(`${BASE_URL}/api/search?q=quantum&type=posts&limit=20`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { external_results?: Array<{ title: string }> };
    assert.ok(Array.isArray(data.external_results));
    assert.ok(data.external_results.some((i) => i.title.includes('Quantum')));
  });
});

describe('GET /api/posts/trending with sources', () => {
  beforeEach(resetDb);

  it('interleaves external items by score when external sources are selected', async () => {
    const { cookie } = await seedUserAndLogin('trending-external');
    const postId = crypto.randomUUID();
    const created = await fetch(`${BASE_URL}/api/posts/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ postId, text: 'A trending post about widgets', hashtags: ['widgets'] }),
    });
    assert.equal(created.status, 200);
    await seedExternalItem({
      source: 'arxiv',
      external_id: 'trend1',
      title: 'Fresh paper title',
      summary: 'Fresh abstract',
      url: 'https://arxiv.org/abs/trend1',
      publish_at: hoursAgoIso(1),
    });

    const res = await fetch(`${BASE_URL}/api/posts/trending?sources=flaxia,arxiv&limit=10`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      posts: Array<{ id: string }>;
      items?: Array<{ kind: string; id: string; score: number }>;
      next_cursor: string | null;
    };
    assert.ok(Array.isArray(data.items), 'mixed feed must return unified items');
    const kinds = data.items.map((i) => i.kind);
    assert.ok(kinds.includes('post'), 'items must include native posts');
    assert.ok(kinds.includes('external'), 'items must include external items');
    for (let i = 1; i < data.items.length; i++) {
      assert.ok(data.items[i - 1].score >= data.items[i].score, 'items must be score-ordered');
    }
    assert.ok(
      data.posts.some((p) => p.id === postId),
      'posts subset must include the native post',
    );
  });

  it('returns flaxia-only shape by default and rejects unknown sources', async () => {
    const res = await fetch(`${BASE_URL}/api/posts/trending?limit=10`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { posts: unknown[]; items?: unknown[] };
    assert.ok(Array.isArray(data.posts));
    const bad = await fetch(`${BASE_URL}/api/posts/trending?sources=flaxia,rss`);
    assert.equal(bad.status, 400);
  });
});
