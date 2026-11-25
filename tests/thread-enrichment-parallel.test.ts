// Thread clicks must not pay for a dozen serial D1 round-trips. The route
// fetches root + replies in one query, so enrichment must be batched over the
// merged array and background work must be scheduled with waitUntil().
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** Slice a Hono handler by its route registration markers. */
function handler(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  assert.notEqual(start, -1, `missing route marker: ${from}`);
  const end = src.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `missing route marker: ${to}`);
  return src.slice(start, end);
}

const repliesSrc = source('../functions/api/routes/posts/replies.ts');
const repliesIndex = handler(repliesSrc, "replies.get('/posts/:id/replies'", "replies.get('/posts/:id/thread'");
const threadSrc = handler(repliesSrc, "replies.get('/posts/:id/thread'", "replies.post('/posts/:id/replies/prepare'");

/** Blank out comments and string literals while preserving character offsets. */
function blankNonCode(src: string): string {
  const chars = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < chars.length; j += 1) if (chars[j] !== '\n') chars[j] = ' ';
  };
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
    } else {
      i += 1;
    }
  }
  return chars.join('');
}

/** Find every `<name>(...)` call and return its balanced argument region. */
function callRegions(src: string, name: string): Array<{ start: number; end: number; body: string }> {
  const code = blankNonCode(src);
  const needle = `${name}(`;
  const regions: Array<{ start: number; end: number; body: string }> = [];
  let cursor = 0;
  while (cursor < src.length) {
    const start = code.indexOf(needle, cursor);
    if (start === -1) break;
    let depth = 1;
    let i = start + needle.length;
    let quote = '';
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) quote = '';
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        i = src.indexOf('\n', i);
        if (i === -1) break;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end === -1 ? src.length : end + 2;
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      i += 1;
    }
    regions.push({ start, end: i, body: src.slice(start, i) });
    cursor = i;
  }
  return regions;
}

function mask(src: string, regions: Array<{ start: number; end: number }>): string {
  const chars = src.split('');
  for (const { start, end } of regions) {
    for (let i = start; i < end; i += 1) if (chars[i] !== '\n') chars[i] = ' ';
  }
  return chars.join('');
}

const SERIAL_ENRICHMENT = /\bawait\s+enrichPostsWith(?:Polls|Quotes|Attachments|Reactions)\s*\(/;

/** Like assert.match but does not dump the whole source file on failure. */
function assertSource(src: string, pattern: RegExp, message: string): void {
  assert.ok(pattern.test(src), message);
}

describe('thread enrichment is batched and off the critical path', () => {
  it('/thread does not await the eight serial enrichment calls', () => {
    assert.ok(
      !SERIAL_ENRICHMENT.test(threadSrc),
      '/thread must not await enrichPostsWithPolls/Quotes/Attachments/Reactions one by one',
    );
  });

  it('/thread enriches a merged [rootPost, ...replies] array in one batch', () => {
    const feedCalls = callRegions(threadSrc, 'enrichPostsForFeed');
    assert.equal(feedCalls.length, 1, '/thread must call enrichPostsForFeed exactly once');

    assertSource(
      threadSrc,
      /const\s+allPosts\b[\s\S]{0,120}?=\s*\[[\s\S]{0,200}?rootPost[\s\S]{0,200}?\.\.\.\s*\(\s*replies/,
      '/thread must build one merged array from rootPost and replies',
    );
    assertSource(
      feedCalls[0].body,
      /\ballPosts\b/,
      'enrichPostsForFeed must operate on the merged array, not just one post',
    );

    // Remote authors must run after feed enrichment: enrichPostsWithQuotes
    // populates quoted_post, which the author helper also inspects.
    const feedIndex = threadSrc.indexOf('await enrichPostsForFeed(');
    const authorsIndex = threadSrc.indexOf('await enrichPostsWithRemoteAuthors(');
    assert.ok(feedIndex > -1 && authorsIndex > -1, 'both batched enrichers must be awaited');
    assert.ok(feedIndex < authorsIndex, 'remote-author enrichment must follow feed enrichment');
  });

  it('/thread schedules the embedding existence check and dispatch via waitUntil', () => {
    assertSource(
      repliesSrc,
      /import\s*\{[^}]*\bwaitUntil\b[^}]*\}\s*from\s*['"][^'"]*(?:background-task|notify)['"]/,
      'waitUntil must be imported from background-task.ts (directly or via notify)',
    );

    const schedules = callRegions(threadSrc, 'waitUntil');
    assert.ok(schedules.length >= 1, '/thread must use waitUntil for background work');
    assert.ok(
      schedules.some(({ body }) => body.includes('post_embeddings') && body.includes('embedPost')),
      'the embedding existence check and embedPost dispatch must live inside waitUntil',
    );

    const criticalPath = mask(threadSrc, schedules);
    assert.ok(!/post_embeddings/.test(criticalPath), 'post_embeddings query must not be awaited inline');
    assert.ok(!/\bembedPost\s*\(/.test(criticalPath), 'embedPost must not be dispatched inline');
    assert.ok(!/\brunInBackground\s*\(/.test(criticalPath), 'background dispatch must not run inline');
  });

  it('/replies does not enrich the same posts twice', () => {
    assert.ok(
      !SERIAL_ENRICHMENT.test(repliesIndex),
      '/replies must not await the per-post enrichment helpers one by one',
    );
    const feedCalls = callRegions(repliesIndex, 'enrichPostsForFeed');
    assert.equal(feedCalls.length, 1, '/replies must enrich parent + replies in exactly one batch');
  });

  it('viewer flags are still produced', () => {
    const feedSrc = source('../functions/api/feed-enrichment.ts');
    const feedFn = feedSrc.slice(
      feedSrc.indexOf('export async function enrichPostsForFeed'),
      feedSrc.indexOf('export async function enrichPostsWithPolls'),
    );
    for (const flag of ['is_freshed', 'is_reloaded', 'is_bookmarked']) {
      assert.ok(
        new RegExp(`${flag}\\s*=`).test(feedFn) || new RegExp(`${flag}\\s*=`).test(threadSrc),
        `${flag} must still be assigned for thread posts`,
      );
    }
  });

  it('response shape and 404 behavior are preserved', () => {
    assertSource(threadSrc, /\{ error: 'Post not found' \}, 404/, 'thread 404 behavior must be preserved');
    assertSource(threadSrc, /\{ root: rootPost, replies \}/, 'thread response shape must be preserved');
    assertSource(repliesIndex, /\{ root: parentPost, replies \}/, 'replies response shape must be preserved');
  });
});
