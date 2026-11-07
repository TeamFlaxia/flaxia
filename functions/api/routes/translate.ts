import { Hono } from 'hono';
import { hasReservedPlamoTokens } from '../../../src/lib/translate-languages.ts';
import { ensureTranslateJobsTable, submitTranslate } from '../../lib/crowd';
import { checkRateLimit, getClientIp } from '../../lib/rate-limit';
import type { Bindings, Variables } from '../types';

const SUPPORTED = new Set([
  'en',
  'ja',
  'ko',
  'zh',
  'fr',
  'de',
  'es',
  'it',
  'pt',
  'ru',
  'ar',
  'hi',
  'nl',
  'pl',
  'sv',
  'tr',
  'vi',
  'th',
  'id',
  'uk',
]);

const LANGUAGES = [...SUPPORTED].map((code) => ({ code }));

const translate = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /api/translate/languages - public language list
translate.get('/translate/languages', (c) => {
  return c.json({ languages: LANGUAGES });
});

// POST /api/translate - public, rate-limited, submits to Crowd via ai-inference
translate.post('/translate', async (c) => {
  const clientIp = getClientIp(c.req.raw);
  const limited = await checkRateLimit(c.env.CACHE, `translate:${clientIp}`, {
    maxRequests: 30,
    windowSeconds: 60,
  });
  if (!limited) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  let body: { text?: unknown; sourceLang?: unknown; targetLang?: unknown };
  try {
    body = (await c.req.json()) as { text?: unknown; sourceLang?: unknown; targetLang?: unknown };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const sourceLang = typeof body.sourceLang === 'string' ? body.sourceLang : 'en';
  const targetLang = typeof body.targetLang === 'string' ? body.targetLang : 'ja';

  if (!text) {
    return c.json({ error: 'Text is required' }, 400);
  }
  if (text.length > 5_000) {
    return c.json({ error: 'Text exceeds 5000 characters' }, 400);
  }
  if (hasReservedPlamoTokens(text)) {
    return c.json({ error: 'Text contains reserved tokens' }, 400);
  }
  if (!SUPPORTED.has(sourceLang) || !SUPPORTED.has(targetLang)) {
    return c.json({ error: 'Unsupported language' }, 400);
  }
  if (sourceLang === targetLang) {
    return c.json({ translatedText: text, status: 'done' });
  }

  if (!c.env.DB) {
    return c.json({ error: 'Database not available' }, 500);
  }

  const result = await submitTranslate(c.env.DB, c.env, { text, sourceLang, targetLang });
  if (!result) {
    return c.json({ error: 'Translation unavailable', status: 'unavailable' }, 503);
  }
  return c.json({ jobId: result.jobId, crowdTaskId: result.crowdTaskId, status: 'pending' }, 202);
});

// GET /api/translate/status?jobId=xxx - poll for the result
translate.get('/translate/status', async (c) => {
  const jobId = c.req.query('jobId');
  if (!jobId || jobId.length > 64) {
    return c.json({ error: 'jobId is required' }, 400);
  }
  if (!c.env.DB) {
    return c.json({ error: 'Database not available' }, 500);
  }
  await ensureTranslateJobsTable(c.env.DB);
  const row = (await c.env.DB.prepare(
    'SELECT task_id, status, translated_text, source_lang, target_lang FROM translate_jobs WHERE task_id = ?',
  )
    .bind(jobId)
    .first()) as {
    task_id: string;
    status: string;
    translated_text: string | null;
    source_lang: string;
    target_lang: string;
  } | null;
  if (!row) {
    return c.json({ error: 'Not found' }, 404);
  }
  return c.json({
    jobId: row.task_id,
    status: row.status,
    translatedText: row.translated_text ?? null,
    sourceLang: row.source_lang,
    targetLang: row.target_lang,
  });
});

export default translate;
