import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildPlamoPrompt,
  hasReservedPlamoTokens,
  isPlamoSupported,
  PLAMO_MODEL_ID,
  translateModelFor,
} from '../src/lib/translate-languages.ts';
import { BASE_URL } from './helpers/setup.ts';

describe('translate model routing', () => {
  it('uses PLaMO for supported pairs', () => {
    assert.equal(isPlamoSupported('ja', 'en'), true);
    assert.equal(isPlamoSupported('en', 'ja'), true);
    assert.equal(isPlamoSupported('fr', 'de'), true);
    assert.equal(translateModelFor('ja', 'en').model, PLAMO_MODEL_ID);
    assert.equal(translateModelFor('ja', 'en').task, 'text-generation');
  });

  it('rejects Korean source instead of loading a second model', () => {
    assert.equal(isPlamoSupported('ko', 'en'), false);
    assert.equal(isPlamoSupported('ko', 'ja'), false);
    assert.throws(() => translateModelFor('ko', 'en'), /unsupported_language_pair/);
    // Decoder was fixed in rev 1c8417ee (ByteFallback), so ja->ko works.
    assert.equal(isPlamoSupported('ja', 'ko'), true);
    assert.equal(translateModelFor('ja', 'ko').model, PLAMO_MODEL_ID);
  });

  it('builds a PFML3 prompt without the leading bos token', () => {
    const prompt = buildPlamoPrompt('会議は来週の月曜日に変更されました。', 'ja', 'en');
    assert.equal(prompt.startsWith('<|plamo:bos|>'), false);
    assert.ok(prompt.includes('<|plamo:tag|>dataset<|plamo:msg|>translation'));
    assert.ok(prompt.includes('<|plamo:val|>ja'));
    assert.ok(prompt.includes('会議は来週の月曜日に変更されました。'));
    assert.ok(prompt.includes('<|plamo:val|>en<|plamo:msg|>'));
    assert.ok(prompt.endsWith('<|plamo:msg|>'));
  });

  it('detects reserved PLaMO tokens', () => {
    assert.equal(hasReservedPlamoTokens('hello <|plamo:msg|>'), true);
    assert.equal(hasReservedPlamoTokens('hello world'), false);
  });
});

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

  it('rejects a pair that needs the retired Xenova model', async () => {
    const res = await fetch(`${BASE_URL}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '안녕하세요', sourceLang: 'ko', targetLang: 'en' }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, 'unsupported_language_pair');
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

  it('rejects reserved PLaMO tokens with 400', async () => {
    const res = await fetch(`${BASE_URL}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello <|plamo:msg|>', sourceLang: 'en', targetLang: 'ja' }),
    });
    assert.equal(res.status, 400);
  });

  it('serves languages without auth', async () => {
    const res = await fetch(`${BASE_URL}/api/translate/languages`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { languages?: Array<{ code: string }> };
    assert.ok(Array.isArray(data.languages));
    assert.ok(data.languages?.some((l) => l.code === 'ja'));
  });
});
