import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { parseArxivAtom, parseHackerNewsAlgolia } from '../functions/lib/external-feed.ts';
import { BASE_URL, resetDb } from './helpers/setup.ts';

async function seedExternalItem(item: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/test/external-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  assert.equal(res.status, 201, 'seed external item');
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

describe('GET /api/external-feed', () => {
  beforeEach(resetDb);

  it('lists sources', async () => {
    const res = await fetch(`${BASE_URL}/api/external-feed/sources`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { sources: Array<{ source: string; source_label: string }> };
    assert.deepEqual(data.sources.map((s) => s.source).sort(), ['arxiv', 'hackernews']);
  });

  it('returns items sorted by publish_at with the 9 requested fields', async () => {
    await seedExternalItem({
      source: 'arxiv',
      external_id: 'a1',
      title: 'Older paper',
      summary: 'old',
      url: 'https://arxiv.org/abs/a1',
      author: 'Ann',
      tags: ['cs.AI'],
      publish_at: '2026-01-01T00:00:00Z',
    });
    await seedExternalItem({
      source: 'hackernews',
      external_id: '42',
      title: 'Newer story',
      summary: '',
      url: 'https://example.com/story',
      author: 'hnuser',
      tags: ['story'],
      publish_at: '2026-02-01T00:00:00Z',
    });

    const res = await fetch(`${BASE_URL}/api/external-feed?source=all&limit=20`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { items: Array<Record<string, unknown>>; next_cursor: string | null };
    assert.equal(data.items.length, 2);
    assert.equal(data.items[0].title, 'Newer story');
    assert.equal(data.items[0].source_label, 'Hacker News');
    assert.deepEqual(data.items[0].tags, ['story']);
    for (const key of ['id', 'title', 'summary', 'url', 'source', 'source_label', 'publish_at', 'author', 'tags']) {
      assert.ok(key in data.items[0], `missing ${key}`);
    }
  });

  it('filters by source and rejects unknown source', async () => {
    await seedExternalItem({
      source: 'arxiv',
      external_id: 'a1',
      title: 'Paper',
      url: 'https://arxiv.org/abs/a1',
      publish_at: '2026-01-01T00:00:00Z',
    });
    const ok = await fetch(`${BASE_URL}/api/external-feed?source=arxiv`);
    assert.equal(ok.status, 200);
    const bad = await fetch(`${BASE_URL}/api/external-feed?source=rss`);
    assert.equal(bad.status, 400);
  });

  it('paginates with cursor without repeats', async () => {
    for (let i = 0; i < 5; i++) {
      await seedExternalItem({
        source: 'hackernews',
        external_id: `p${i}`,
        title: `Story ${i}`,
        url: `https://example.com/${i}`,
        publish_at: `2026-01-0${i + 1}T00:00:00Z`,
      });
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ source: 'hackernews', limit: '2' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`${BASE_URL}/api/external-feed?${params}`);
      assert.equal(res.status, 200);
      const data = (await res.json()) as { items: Array<{ id: string }>; next_cursor: string | null };
      ids.push(...data.items.map((i) => i.id));
      cursor = data.next_cursor;
      if (!cursor) break;
    }
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5);
  });

  it('rejects invalid cursor', async () => {
    const res = await fetch(`${BASE_URL}/api/external-feed?source=all&cursor=bad`);
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
      publish_at: '2026-01-01T00:00:00Z',
    });
    const res = await fetch(`${BASE_URL}/api/search?q=quantum&type=posts&limit=20`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { external_results?: Array<{ title: string }> };
    assert.ok(Array.isArray(data.external_results));
    assert.ok(data.external_results.some((i) => i.title.includes('Quantum')));
  });
});
