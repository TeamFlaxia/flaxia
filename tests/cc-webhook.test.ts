import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { crowdConfig, signedCallbackUrl } from '../functions/lib/crowd.ts';
import { BASE_URL, resetDb } from './helpers/setup.ts';

const WARC_PATH =
  'crawl-data/CC-MAIN-2026-43/segments/1700000000000.0/warc/CC-MAIN-20260101000000-20260101010000-00000.warc.gz';

const config = crowdConfig({
  CROWD_ORCHESTRATOR_URL: 'http://127.0.0.1:9',
  CROWD_API_KEY: 'test-api-key',
  CROWD_WEBHOOK_SECRET: 'test-callback-secret',
  BASE_URL,
});

async function seedQueue(taskId: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/test/cc-queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      crawl: 'CC-MAIN-2026-43',
      url: 'https://example.com/articles/cc-webhook-flamingo',
      warcFilename: WARC_PATH,
      offset: 0,
      length: 1000,
      taskId,
      status: 'submitted',
    }),
  });
  assert.equal(response.status, 201);
}

describe('cc-extract webhook', () => {
  beforeEach(resetDb);

  it('stores an extracted document and makes it searchable', async () => {
    const taskId = 'cc-task-webhook-1';
    await seedQueue(taskId);
    const callback = await signedCallbackUrl(config, { baseUrl: BASE_URL, type: 'cc-extract' });

    const response = await fetch(callback, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        status: 'done',
        result: {
          output: {
            documents: [
              {
                url: 'https://example.com/articles/cc-webhook-flamingo',
                finalUrl: 'https://example.com/articles/cc-webhook-flamingo',
                canonicalUrl: 'https://example.com/articles/cc-webhook-flamingo',
                title: 'Webhookflamingo result',
                text: 'A webhookflamingo fixture about migration and wetlands.',
                excerpt: 'A webhookflamingo fixture about migration and wetlands.',
                lang: 'en',
                publishedAt: '2026-10-01T12:00:00Z',
                contentType: 'text/html',
                httpStatus: 200,
                warcFilename: WARC_PATH,
                offset: 0,
                length: 1000,
                truncated: false,
              },
            ],
          },
        },
      }),
    });
    assert.equal(response.status, 200);

    const search = await fetch(`${BASE_URL}/api/search/v2?q=webhookflamingo&tab=web&limit=20`);
    assert.equal(search.status, 200);
    const data = (await search.json()) as { web?: Array<{ url: string }> };
    assert.ok(data.web?.some((result) => result.url === 'https://example.com/articles/cc-webhook-flamingo'));
  });

  it('does not index a document that is not a 2xx text/html response', async () => {
    const taskId = 'cc-task-webhook-3';
    await seedQueue(taskId);
    const callback = await signedCallbackUrl(config, { baseUrl: BASE_URL, type: 'cc-extract' });

    const response = await fetch(callback, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        status: 'done',
        result: {
          output: {
            documents: [
              {
                url: 'https://example.com/articles/error-page',
                finalUrl: 'https://example.com/articles/error-page',
                title: 'Flamingo error page',
                text: 'An error page mentioning flamingo that must not be indexed.',
                excerpt: 'flamingo error page',
                contentType: 'text/html',
                httpStatus: 500,
                warcFilename: WARC_PATH,
                offset: 0,
                length: 1000,
                truncated: false,
              },
            ],
          },
        },
      }),
    });
    assert.equal(response.status, 200);

    const search = await fetch(`${BASE_URL}/api/search/v2?q=flamingo&tab=web&limit=20`);
    assert.equal(search.status, 200);
    const data = (await search.json()) as { web?: Array<{ url: string }> };
    assert.ok(!data.web?.some((result) => result.url === 'https://example.com/articles/error-page'));
  });

  it('keeps an unsigned callback out of the index', async () => {
    const taskId = 'cc-task-webhook-2';
    await seedQueue(taskId);

    const callback = await signedCallbackUrl(config, { baseUrl: BASE_URL, type: 'cc-extract' });
    const forged = new URL(callback);
    forged.searchParams.delete('sig');

    const response = await fetch(forged, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, status: 'done', result: { output: { documents: [] } } }),
    });
    assert.equal(response.status, 401);
  });
});
