// Cross-instance mentions: parsing, outbound HTML safety, Note audience and
// client-side link targets. Kept dependency-light so it runs with plain Node.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Window } from 'happy-dom';

import { buildNoteObject } from '../functions/lib/activitypub/note.ts';
import { extractMentionHandles, extractMentions, textToHtml } from '../functions/lib/activitypub/text.ts';

const BASE = 'https://flaxia.app';
const USER = { id: 'u1', username: 'alice', display_name: 'Alice' };
const FOLLOWERS = `${BASE}/api/actors/alice/followers`;
const REMOTE_URL = 'https://example.org/users/bob';

describe('mention parsing', () => {
  it('keeps the domain of a cross-instance handle', () => {
    assert.deepEqual(extractMentionHandles('hi @alice and @bob@example.org'), [
      { username: 'alice', domain: null },
      { username: 'bob', domain: 'example.org' },
    ]);
    assert.deepEqual(extractMentions('hi @alice and @bob@example.org'), ['alice', 'bob']);
  });

  it('does not misread an email address as a mention', () => {
    assert.deepEqual(extractMentionHandles('write to foo@example.com'), []);
    assert.deepEqual(extractMentions('write to foo@example.com'), []);
    assert.deepEqual(extractMentionHandles('mail foo@example.com and ping @alice'), [
      { username: 'alice', domain: null },
    ]);
  });

  it('deduplicates repeated handles', () => {
    assert.deepEqual(extractMentionHandles('@bob@example.org @bob@example.org @bob'), [
      { username: 'bob', domain: 'example.org' },
      { username: 'bob', domain: null },
    ]);
  });
});

describe('federated HTML rendering', () => {
  it('links URLs and mentions in one pass without corrupting attributes', () => {
    const html = textToHtml('see https://example.com/@bob and @alice@example.org #flaxia', BASE, {
      'alice@example.org': REMOTE_URL,
    });
    assert.ok(
      html.includes(
        '<a href="https://example.com/@bob" rel="nofollow noopener noreferrer" target="_blank">https://example.com/@bob</a>',
      ),
      `URL anchor was altered: ${html}`,
    );
    assert.ok(html.includes(`href="${REMOTE_URL}"`), `remote mention was not linked: ${html}`);
    assert.ok(html.includes('>@alice@example.org</a>'));
    assert.ok(html.includes('href="https://flaxia.app/tags/flaxia"'));
    assert.ok(!/href="[^"]*<span/.test(html), 'no mention markup may appear inside a URL attribute');
  });

  it('still escapes raw markup and escapes remote URLs in attributes', () => {
    const unsafe = textToHtml('<script>alert(1)</script> & "quotes"', BASE);
    assert.ok(unsafe.includes('&lt;script&gt;'));
    assert.ok(!unsafe.includes('<script>'));

    const injected = textToHtml('hi @bob@example.org', BASE, {
      'bob@example.org': 'https://example.org/" onmouseover="evil()',
    });
    assert.ok(!injected.includes('onmouseover="evil()'), `attribute injection: ${injected}`);
    assert.ok(injected.includes('&quot; onmouseover=&quot;evil()'));
  });
});

describe('remote Note mentions', () => {
  it('tags and addresses a remote actor with its full handle', () => {
    const note = buildNoteObject(
      {
        id: 'post-1',
        text: 'hello @bob@example.org',
        created_at: '2026-01-01T00:00:00.000Z',
        visibility: 'direct',
        mentions: [{ username: 'bob', domain: 'example.org', url: REMOTE_URL, name: 'Bob' }],
      },
      USER,
      BASE,
      { followersUrl: FOLLOWERS },
    );

    assert.deepEqual(note.to, [REMOTE_URL]);
    assert.deepEqual(note.cc, []);
    assert.ok(
      note.tag?.some((tag) => tag.type === 'Mention' && tag.name === '@bob@example.org' && tag.href === REMOTE_URL),
    );
    assert.ok(note.content.includes(`href="${REMOTE_URL}"`));
  });

  it('ccs a remote actor on a public post and rejects non-http mention URLs', () => {
    const note = buildNoteObject(
      {
        id: 'post-2',
        text: 'hi @bob@example.org @alice',
        created_at: '2026-01-01T00:00:00.000Z',
        mentions: [
          { username: 'bob', domain: 'example.org', url: REMOTE_URL },
          { username: 'eve', domain: 'evil.example', url: 'javascript:alert(1)' },
        ],
      },
      USER,
      BASE,
      { followersUrl: FOLLOWERS },
    );

    assert.deepEqual(note.to, ['https://www.w3.org/ns/activitystreams#Public']);
    assert.deepEqual(note.cc, [FOLLOWERS, REMOTE_URL]);
    assert.ok(!(note.tag ?? []).some((tag) => tag.href === 'javascript:alert(1)'));
  });
});

describe('client-side mention links', () => {
  const window = new Window({ url: 'https://flaxia.test/' });
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = window;
  globals.document = window.document;
  globals.Node = window.Node;
  globals.Element = window.Element;
  globals.HTMLElement = window.HTMLElement;
  globals.Text = window.Text;
  globals.DocumentFragment = window.DocumentFragment;
  globals.NodeFilter = window.NodeFilter;

  it('targets /@domain/user for remote handles and /profile/user for local ones', async () => {
    const { linkifyMentions } = await import('../src/lib/post/text-links.ts');
    const container = document.createElement('div');
    container.appendChild(document.createTextNode('hi @bob@example.org and @known and foo@example.com'));
    linkifyMentions(
      container,
      JSON.stringify([
        { username: 'known', user_id: 'u2' },
        { username: 'bob', domain: 'example.org', url: REMOTE_URL },
      ]),
    );

    const links = Array.from(container.querySelectorAll('.mention-link'));
    assert.equal(links.length, 2);
    assert.equal(links[0].textContent, '@bob@example.org');
    assert.equal(links[0].getAttribute('data-mention-target'), '/@example.org/bob');
    assert.equal(links[1].textContent, '@known');
    assert.equal(links[1].getAttribute('data-mention-target'), '/profile/known');
  });

  it('leaves mentions inside anchors and code untouched', async () => {
    const { linkifyMentions } = await import('../src/lib/post/text-links.ts');
    const container = document.createElement('div');
    const anchor = document.createElement('a');
    anchor.href = 'https://already.test';
    anchor.textContent = '@bob@example.org';
    const code = document.createElement('code');
    code.textContent = '@bob@example.org';
    container.append(anchor, code);
    container.appendChild(document.createTextNode('@bob@example.org'));

    linkifyMentions(container, '[]');
    assert.equal(container.querySelectorAll('.mention-link').length, 1);
    assert.equal(anchor.querySelector('.mention-link'), null);
    assert.equal(code.querySelector('.mention-link'), null);
  });
});
