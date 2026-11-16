import './setup.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flushEffects, html, mount, signal, when } from '../../src/lib/render/index.ts';

function createRoot(): HTMLElement {
  return document.createElement('div');
}

function textNodeOf(element: Element): Text {
  const node = [...element.childNodes].find((child) => child.nodeType === 3);
  assert.ok(node, 'expected a text node');
  return node as Text;
}

describe('render/template', () => {
  it('creates static markup once', () => {
    const root = createRoot();
    mount(root, () => html`<article class="card"><h1>Hello</h1></article>`);
    assert.equal(root.querySelector('article.card h1')?.textContent, 'Hello');
  });

  it('updates text in place without replacing the text node', () => {
    const root = createRoot();
    const name = signal('first');
    mount(root, () => html`<p>${() => name()}</p>`);

    const paragraph = root.querySelector('p');
    assert.ok(paragraph);
    const text = textNodeOf(paragraph);
    assert.equal(paragraph.textContent, 'first');

    name.set('second');
    flushEffects();

    assert.equal(paragraph.textContent, 'second');
    assert.equal(textNodeOf(paragraph), text);
  });

  it('renders interpolated HTML as text', () => {
    const root = createRoot();
    mount(root, () => html`<p>${'<img src=x onerror=alert(1)>'}</p>`);

    assert.equal(root.querySelector('img'), null);
    assert.equal(root.querySelector('p')?.textContent, '<img src=x onerror=alert(1)>');
  });

  it('binds attributes and updates them through accessors', () => {
    const root = createRoot();
    const className = signal('alpha');
    mount(root, () => html`<div class=${() => className()} title="${'static'}"></div>`);

    const div = root.querySelector('div');
    assert.ok(div);
    assert.equal(div.getAttribute('class'), 'alpha');
    assert.equal(div.getAttribute('title'), 'static');

    className.set('beta');
    flushEffects();
    assert.equal(div.getAttribute('class'), 'beta');
  });

  it('binds DOM properties', () => {
    const root = createRoot();
    const value = signal('a');
    mount(root, () => html`<input .value=${() => value()}>`);

    const input = root.querySelector('input');
    assert.ok(input);
    assert.equal(input.value, 'a');

    value.set('b');
    flushEffects();
    assert.equal(input.value, 'b');
  });

  it('binds boolean attributes', () => {
    const root = createRoot();
    const disabled = signal(true);
    mount(root, () => html`<button ?disabled=${() => disabled()}>run</button>`);

    const button = root.querySelector('button');
    assert.ok(button);
    assert.equal(button.hasAttribute('disabled'), true);

    disabled.set(false);
    flushEffects();
    assert.equal(button.hasAttribute('disabled'), false);
  });

  it('keeps the event listener working across signal updates', () => {
    const root = createRoot();
    const target = signal<'first' | 'second'>('first');
    const calls: string[] = [];

    mount(
      root,
      () =>
        html`<button
          @click=${() => {
            calls.push(target());
          }}
        >
          go
        </button>`,
    );

    const button = root.querySelector('button');
    assert.ok(button);
    button.dispatchEvent(new Event('click'));
    target.set('second');
    flushEffects();
    button.dispatchEvent(new Event('click'));
    assert.deepEqual(calls, ['first', 'second']);
  });

  it('passes the element to ref and clears it on dispose', () => {
    const root = createRoot();
    let seen: Element | null = null;
    const mounted = mount(
      root,
      () =>
        html`<div ref=${(element: Element | null) => {
          seen = element;
        }}></div>`,
    );

    assert.equal(seen, root.querySelector('div'));
    mounted.dispose();
    assert.equal(seen, null);
  });

  it('renders nested templates', () => {
    const root = createRoot();
    const child = html`<span class="child">inside</span>`;
    mount(root, () => html`<div>${child}</div>`);
    assert.equal(root.querySelector('.child')?.textContent, 'inside');
  });

  it('conditionally renders with when()', () => {
    const root = createRoot();
    const open = signal(false);
    mount(
      root,
      () =>
        html`<section>
          ${when(
            open,
            () => html`<p class="open">open</p>`,
            () => html`<p class="closed">closed</p>`,
          )}
        </section>`,
    );

    assert.equal(root.querySelector('.closed')?.textContent, 'closed');
    open.set(true);
    flushEffects();
    assert.equal(root.querySelector('.open')?.textContent, 'open');
    assert.equal(root.querySelector('.closed'), null);
  });

  it('throws on a partial attribute interpolation', () => {
    assert.throws(() => html`<div class="a ${'b'}"></div>`, /entire attribute value/);
  });

  it('throws on child interpolation inside a textarea', () => {
    assert.throws(() => html`<textarea>${'value'}</textarea>`, /script\/style\/textarea/);
  });

  it('removes listeners and nodes on dispose', () => {
    const root = createRoot();
    let calls = 0;
    const mounted = mount(
      root,
      () =>
        html`<button @click=${() => {
          calls++;
        }}>go</button>`,
    );

    const button = root.querySelector('button');
    assert.ok(button);
    button.dispatchEvent(new Event('click'));
    assert.equal(calls, 1);

    mounted.dispose();
    assert.equal(root.childNodes.length, 0);
    button.dispatchEvent(new Event('click'));
    assert.equal(calls, 1);
  });
});
