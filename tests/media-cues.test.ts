import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasPostColors, stripPostColors } from '../src/lib/post-colors.ts';
import { parseMediaCues, stripMediaCues } from '../src/lib/post-cues.ts';
import { type PostRow, renderPostArticle } from '../src/lib/render-html.ts';

function post(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: 'post-1',
    user_id: 'user-1',
    username: 'alice',
    display_name: 'Alice',
    avatar_key: null,
    badge_type: 'flaxia_plus',
    name_color: null,
    text: '',
    hashtags: '[]',
    gif_key: null,
    payload_key: null,
    swf_key: null,
    thumbnail_key: null,
    fresh_count: 0,
    bookmark_count: 0,
    reply_count: 0,
    impressions: 0,
    parent_id: null,
    root_id: null,
    depth: 0,
    status: 'published',
    hidden: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('parseMediaCues', () => {
  it('parses an Under cue as a bottom subtitle at the given time', () => {
    const { cues, plain } = parseMediaCues('Under 01:36.12 test Comment $F=ma$');
    assert.equal(plain, '');
    assert.deepEqual(cues, [{ timeMs: 96_120, text: 'test Comment $F=ma$', kind: 'bottom' }]);
  });

  it('parses Over and bare (danmaku) and case-insensitive keywords', () => {
    const { cues } = parseMediaCues(
      'Over 0:05.00 top\n00:01.50 bare scroll\nScroll 0:02.00 explicit\nunder 0:03.00 lower',
    );
    assert.deepEqual(
      cues.map((c) => [c.kind, c.timeMs]),
      [
        ['danmaku', 1_500],
        ['danmaku', 2_000],
        ['bottom', 3_000],
        ['top', 5_000],
      ],
    );
  });

  it('keeps centisecond precision and total minutes above 59', () => {
    const { cues } = parseMediaCues('125:30.09 long');
    assert.equal(cues[0].timeMs, (125 * 60 + 30) * 1000 + 90);
  });

  it('sorts cues by time, keeping line order for equal timestamps', () => {
    const { cues } = parseMediaCues('00:09.00 nine\n00:01.00 one\n00:01.00 also one');
    assert.deepEqual(
      cues.map((c) => c.text),
      ['one', 'also one', 'nine'],
    );
  });

  it('removes cue lines from the body but keeps the rest of the text', () => {
    const { plain, cues } = parseMediaCues('hello world\nUnder 00:10.00 sub\nsecond line');
    assert.equal(plain, 'hello world\nsecond line');
    assert.equal(cues.length, 1);
  });

  it('leaves the surrounding text untouched when no cues exist', () => {
    const text = 'plain **markdown** with $math$ and {red}not a cue{/red}';
    const { plain, cues } = parseMediaCues(text);
    assert.equal(plain, text);
    assert.deepEqual(cues, []);
  });

  it('rejects out-of-range seconds and keeps the line literal', () => {
    const { plain, cues } = parseMediaCues('Under 00:60.00 nope');
    assert.equal(plain, 'Under 00:60.00 nope');
    assert.deepEqual(cues, []);
  });

  it('rejects a fraction that is not exactly two digits', () => {
    for (const line of ['Under 00:10.5 x', 'Under 00:10.123 x', 'Under 00:10 x']) {
      const { plain, cues } = parseMediaCues(line);
      assert.equal(plain, line);
      assert.deepEqual(cues, []);
    }
  });

  it('rejects an empty cue body', () => {
    const { plain, cues } = parseMediaCues('Under 00:10.00');
    assert.equal(plain, 'Under 00:10.00');
    assert.deepEqual(cues, []);
  });

  it('escapes a cue-looking line with a leading backslash', () => {
    const { plain, cues } = parseMediaCues('\\Under 00:10.00 literal\n\\01:36.12 also literal');
    assert.equal(plain, 'Under 00:10.00 literal\n01:36.12 also literal');
    assert.deepEqual(cues, []);
  });

  it('allows up to three leading spaces before a cue', () => {
    const { cues, plain } = parseMediaCues('   Under 00:10.00 spaced');
    assert.equal(plain, '');
    assert.equal(cues.length, 1);
  });

  it('treats four leading spaces as an indented code block, never a cue', () => {
    const { plain, cues } = parseMediaCues('    Under 00:10.00 code');
    assert.equal(plain, '    Under 00:10.00 code');
    assert.deepEqual(cues, []);
  });

  it('does not parse cues inside fenced code blocks', () => {
    const text = '```\nUnder 00:10.00 inside\n```\nUnder 00:20.00 outside';
    const { plain, cues } = parseMediaCues(text);
    assert.equal(plain, '```\nUnder 00:10.00 inside\n```');
    assert.equal(cues.length, 1);
    assert.equal(cues[0].timeMs, 20_000);
  });

  it('does not parse a line that starts with inline code', () => {
    const { plain, cues } = parseMediaCues('`00:10.00 x`');
    assert.equal(plain, '`00:10.00 x`');
    assert.deepEqual(cues, []);
  });

  it('keeps the cue body raw so KaTeX can render it later', () => {
    const { cues } = parseMediaCues('Under 00:10.00 $F=ma$ and $$x^2$$');
    assert.equal(cues[0].text, '$F=ma$ and $$x^2$$');
  });

  it('trims trailing spaces from the body', () => {
    const { cues } = parseMediaCues('Under 00:10.00 padded   ');
    assert.equal(cues[0].text, 'padded');
  });

  it('handles minutes with a single digit and seconds with a single digit', () => {
    const { cues } = parseMediaCues('1:5.00 x');
    assert.equal(cues[0].timeMs, 65_000);
  });
});

describe('stripMediaCues / stripPostColors', () => {
  it('stripMediaCues removes cue lines and keeps the rest', () => {
    assert.equal(stripMediaCues('a\n00:01.00 b\n\nc'), 'a\n\nc');
  });

  it('stripPostColors strips cue lines as well as color markers', () => {
    assert.equal(stripPostColors('Under 00:10.00 {red}secret{/red}\nvisible {blue}text{/blue}'), 'visible text');
  });

  it('color markers inside a cue body are not counted as post colors', () => {
    assert.equal(hasPostColors('Under 00:10.00 {red}hi{/red}'), false);
    assert.equal(hasPostColors('body {red}hi{/red}'), true);
  });

  it('stripPostColors on a cue-only post yields an empty string', () => {
    assert.equal(stripPostColors('01:36.12 only cues\nUnder 00:01.00 second'), '');
  });
});

describe('SSR rendering', () => {
  it('never renders cue lines in the article HTML', () => {
    const html = renderPostArticle(
      post({ text: 'visible body\nUnder 01:36.12 hidden subtitle\n01:36.20 hidden danmaku' }),
      'https://flaxia.app',
    );
    assert.match(html, /visible body/);
    assert.doesNotMatch(html, /hidden subtitle|hidden danmaku|01:36\.\d+/);
  });

  it('replaces cue-only bodies with empty content, without leaking markers', () => {
    const html = renderPostArticle(post({ text: 'Under 01:36.12 only' }), 'https://flaxia.app');
    assert.doesNotMatch(html, /01:36/);
  });
});
