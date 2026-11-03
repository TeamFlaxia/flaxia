import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { BASE_URL, resetDb } from './helpers/setup.ts';

interface WebResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

async function seedWebDoc(input: { url: string; title: string; excerpt: string; lang?: string }): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/test/web-doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 201);
}

async function searchWeb(query: string): Promise<WebResult[]> {
  const response = await fetch(`${BASE_URL}/api/search/v2?q=${encodeURIComponent(query)}&tab=web&limit=20`);
  assert.equal(response.status, 200);
  const data = (await response.json()) as { web?: WebResult[] };
  return data.web || [];
}

describe('Common Crawl web index', () => {
  beforeEach(resetDb);

  it('returns indexed documents through lexical search', async () => {
    await seedWebDoc({
      url: 'https://example.com/articles/flamingos',
      title: 'Flamingo migration notes',
      excerpt: 'A long note about flamingo migration and wetland conservation.',
      lang: 'en',
    });

    const results = await searchWeb('flamingo');
    assert.ok(results.some((result) => result.url === 'https://example.com/articles/flamingos'));
  });

  it('honors the site: filter', async () => {
    await seedWebDoc({
      url: 'https://example.com/articles/flamingos',
      title: 'Flamingo migration notes',
      excerpt: 'A long note about flamingo migration.',
    });
    await seedWebDoc({
      url: 'https://other.test/articles/flamingos',
      title: 'Flamingo migration elsewhere',
      excerpt: 'Another note about flamingo migration.',
    });

    const results = await searchWeb('flamingo site:example.com');
    assert.ok(results.length > 0);
    assert.ok(results.every((result) => new URL(result.url).hostname === 'example.com'));
  });

  it('does not return documents that do not match the query', async () => {
    await seedWebDoc({
      url: 'https://example.com/articles/flamingos',
      title: 'Flamingo migration notes',
      excerpt: 'A long note about flamingo migration.',
    });

    const results = await searchWeb('quantum entanglement');
    assert.equal(results.length, 0);
  });
});
