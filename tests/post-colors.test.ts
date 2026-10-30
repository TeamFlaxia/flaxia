import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canUsePostColors } from '../src/lib/entitlements.ts';
import { hasPostColors, parsePostColors, stripPostColors } from '../src/lib/post-colors.ts';
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

describe('post text colors', () => {
  it('parses a simple span and removes the markers', () => {
    const result = parsePostColors('{red}hello{/red}');
    assert.equal(result.plain, 'hello');
    assert.deepEqual(result.spans, [{ start: 0, end: 5, style: 'red', depth: 0 }]);
  });

  it('accepts Japanese aliases', () => {
    const result = parsePostColors('{赤}あか{/赤}');
    assert.equal(result.plain, 'あか');
    assert.deepEqual(result.spans, [{ start: 0, end: 2, style: 'red', depth: 0 }]);
  });

  it('accepts the extra palette styles and upside-down text', () => {
    for (const [marker, style] of [
      ['mikan', 'mikan'],
      ['蜜柑', 'mikan'],
      ['kimwaipu', 'kimwaipu'],
      ['キムワイプ', 'kimwaipu'],
      ['rainbow', 'rainbow'],
      ['虹', 'rainbow'],
      ['Dinnerborn', 'dinnerborn'],
      ['Dinnerbone', 'dinnerborn'],
    ] as const) {
      const result = parsePostColors(`{${marker}}x{/${marker}}`);
      assert.equal(result.plain, 'x');
      assert.deepEqual(result.spans, [{ start: 0, end: 1, style, depth: 0 }]);
    }
  });

  it('keeps nested spans ordered by depth', () => {
    const result = parsePostColors('{red}a {blue}b{/blue} c{/red}');
    assert.equal(result.plain, 'a b c');
    assert.deepEqual(
      result.spans.sort((a, b) => a.start - b.start),
      [
        { start: 0, end: 5, style: 'red', depth: 0 },
        { start: 2, end: 3, style: 'blue', depth: 1 },
      ],
    );
  });

  it('leaves unclosed and mismatched markers literal', () => {
    for (const text of ['{red}unclosed', '{red}text{/blue}', '{red}', '{nope}text{/nope}', '{ red}text{/red}']) {
      const result = parsePostColors(text);
      assert.equal(result.plain, text);
      assert.equal(result.spans.length, 0);
    }
  });

  it('honors the backslash escape', () => {
    const text = '\\{red}literal{/red}';
    const result = parsePostColors(text);
    assert.equal(result.plain, text);
    assert.equal(result.spans.length, 0);
    assert.equal(stripPostColors(text), '{red}literal{/red}');
    assert.equal(stripPostColors('{Dinnerborn}flip{/Dinnerborn}'), 'flip');
  });

  it('does not parse markers in inline code', () => {
    const result = parsePostColors('`{red}code{/red}`');
    assert.equal(result.plain, '`{red}code{/red}`');
    assert.equal(result.spans.length, 0);
  });

  it('does not parse markers in fenced code', () => {
    const text = '```\n{red}code{/red}\n```';
    const result = parsePostColors(text);
    assert.equal(result.plain, text);
    assert.equal(result.spans.length, 0);
  });

  it('does not parse markers in math', () => {
    const result = parsePostColors('$x{red}$');
    assert.equal(result.plain, '$x{red}$');
    assert.equal(result.spans.length, 0);
  });

  it('does not parse markers in indented code', () => {
    const text = '    {red}code{/red}';
    const result = parsePostColors(text);
    assert.equal(result.plain, text);
    assert.equal(result.spans.length, 0);
  });

  it('rejects spans crossing a blank line or a new list item', () => {
    for (const text of ['{red}a\n\nb{/red}', '{red}a\n- b{/red}', '{red}a\n> b{/red}']) {
      const result = parsePostColors(text);
      assert.equal(result.plain, text);
      assert.equal(result.spans.length, 0);
    }
  });

  it('allows spans across a soft line break and within a list item', () => {
    const soft = parsePostColors('{red}a\nb{/red}');
    assert.equal(soft.plain, 'a\nb');
    assert.equal(soft.spans.length, 1);

    const list = parsePostColors('- {red}item{/red}');
    assert.equal(list.plain, '- item');
    assert.equal(list.spans.length, 1);
  });

  it('supports adjacent and empty spans', () => {
    const adjacent = parsePostColors('{red}a{/red}{blue}b{/blue}');
    assert.equal(adjacent.plain, 'ab');
    assert.equal(adjacent.spans.length, 2);

    const empty = parsePostColors('{red}{/red}');
    assert.equal(empty.plain, '');
    assert.equal(empty.spans.length, 1);
  });

  it('reports whether any valid span exists', () => {
    assert.equal(hasPostColors('{red}x{/red}'), true);
    assert.equal(hasPostColors('no colors'), false);
    assert.equal(hasPostColors('{red}unclosed'), false);
  });

  it('gates the feature on Flaxia+ or reviewer access', () => {
    assert.equal(canUsePostColors({ badge_type: 'flaxia_plus' }), true);
    assert.equal(canUsePostColors({ badge_type: 'flaxia_plus', role: 'user' }), true);
    assert.equal(canUsePostColors({ badge_type: null, role: 'reviewer' }), true);
    assert.equal(canUsePostColors({ badge_type: 'flaxia_sharp', role: 'user' }), false);
    assert.equal(canUsePostColors({ badge_type: null, role: 'user' }), false);
    assert.equal(canUsePostColors(null), false);
  });

  it('renders color spans in SSR for entitled authors', () => {
    const html = renderPostArticle(post({ text: '{red}hello{/red} #tag' }), 'https://flaxia.app');
    assert.match(html, /<span class="post-color--red">hello<\/span>/);
    assert.match(html, /class="ssr-hashtag">#tag<\/a>/);
    assert.doesNotMatch(html, /\{red\}|\{\/red\}/);
  });

  it('renders the extra palette classes and Dinnerborn in SSR', () => {
    const html = renderPostArticle(
      post({
        text: '{mikan}蜜柑{/mikan} {kimwaipu}キムワイプ{/kimwaipu} {rainbow}虹{/rainbow} {Dinnerborn}flip{/Dinnerborn}',
      }),
      'https://flaxia.app',
    );
    assert.match(html, /<span class="post-color--mikan">蜜柑<\/span>/);
    assert.match(html, /<span class="post-color--kimwaipu">キムワイプ<\/span>/);
    assert.match(html, /<span class="post-color--rainbow">虹<\/span>/);
    assert.match(html, /<span class="post-dinnerborn">flip<\/span>/);
  });

  it('leaves markers literal in SSR for non-entitled authors', () => {
    const html = renderPostArticle(post({ badge_type: null, text: '{red}hello{/red}' }), 'https://flaxia.app');
    assert.match(html, /\{red\}hello\{\/red\}/);
    assert.doesNotMatch(html, /post-color--red/);
  });

  it('does not emit unmatched tags for an empty span', () => {
    const html = renderPostArticle(post({ text: '{red}{/red}' }), 'https://flaxia.app');
    assert.doesNotMatch(html, /<\/span>\s*<span class="post-color/);
    assert.doesNotMatch(html, /post-color--red/);
  });

  it('escapes HTML inside color spans', () => {
    const html = renderPostArticle(post({ text: '{red}<script>alert(1)</script>{/red}' }), 'https://flaxia.app');
    assert.match(html, /<span class="post-color--red">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
    assert.doesNotMatch(html, /<script>alert/);
  });

  it('treats an escaped opening brace as literal text in SSR', () => {
    const html = renderPostArticle(post({ text: '\\{red}literal{/red}' }), 'https://flaxia.app');
    assert.match(html, /\{red\}literal\{\/red\}/);
    assert.doesNotMatch(html, /post-color--red/);
  });
});
