import assert from 'node:assert';
import { describe, it } from 'node:test';
import { BASE_URL } from './helpers/setup.ts';

describe('POST /api/translate (public)', () => {
  it('rejects empty text with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ', sourceLang: 'en', targetLang: 'ja' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unsupported language with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', sourceLang: 'xx', targetLang: 'ja' }),
    });
    assert.equal(res.status, 400);
  });

  it('returns echo when source equals target without Crowd', async () => {
    const res = await fetch(`${BASE_URL}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', sourceLang: 'en', targetLang: 'en' }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { translatedText?: string; status?: string };
    assert.equal(data.translatedText, 'hello');
    assert.equal(data.status, 'done');
  });

  it('serves languages without auth', async () => {
    const res = await fetch(`${BASE_URL}/api/translate/languages`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { languages?: Array<{ code: string }> };
    assert.ok(Array.isArray(data.languages));
    assert.ok(data.languages?.some((l) => l.code === 'ja'));
  });
});
