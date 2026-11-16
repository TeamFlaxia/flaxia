# flaxia-render

A small fine-grained DOM renderer extracted from Flaxia's SNS UI.

It is not a general-purpose framework. It exists to keep a list of interactive
cards stable: a keyed reorder moves the existing DOM instead of recreating it, so
an `<iframe>`, `<video>`, `<canvas>` or focused input inside a card keeps its
state. Updates are applied to individual text nodes and attributes rather than a
re-rendered subtree.

- Zero runtime dependencies
- Signals + tagged templates, no compiler and no `eval`
- Keyed lists, conditional branches, explicit ownership and cleanup
- Async resources with an `AbortSignal` and stale-response protection
- Interpolated values always go through DOM APIs, never `innerHTML`

## Install

```sh
npm install flaxia-render
```

During extraction, Flaxia consumes the source through
`src/lib/render/index.ts`; the package itself is built with Vite.

## Quick start

```ts
import { each, html, mount, signal, when } from 'flaxia-render';

const open = signal(false);
const posts = signal([{ id: 'a', text: 'hello' }]);

const mounted = mount(document.querySelector('#app')!, () =>
  html`<main>
    <button @click=${() => open.set(!open.peek())}>toggle</button>
    ${when(open, () => html`<p>open</p>`, () => html`<p>closed</p>`)}
    ${each(
      () => posts(),
      (post) => post.id,
      (post) => html`<article data-id=${post().id}>${() => post().text}</article>`,
    )}
  </main>`,
);

// Later
mounted.dispose();
```

## Reactivity

| Export | Purpose |
|---|---|
| `signal(value)` | Read with `value()`, write with `set(next)` or `set(previous => next)`. `peek()` reads without tracking. |
| `computed(fn)` | Lazy, cached value. Recomputed when a dependency version changes. |
| `effect(fn)` | Runs immediately, then in a microtask after a write. A returned function is the cleanup. |
| `batch(fn)` | Coalesces writes into one flush. |
| `untrack(fn)` | Reads inside are not tracked. |
| `flushEffects()` | Test/synchronous hand-off helper. |

## Templates

`html` compiles once per call site and clones a `<template>`. Supported
bindings, with the interpolation occupying the entire value:

```ts
html`<div class=${className} title="${title}">`
html`<input .value=${() => draft()}>`
html`<button ?disabled=${() => busy()} @click=${save}>`
html`<canvas ref=${(element) => { canvas = element; }}>`
```

A function in a child or normal attribute position is an accessor and is
subscribed with `effect()`. A function in an event position is the handler.

Limitations:

- no spread (`...${props}`) or attribute-name interpolation;
- no child interpolation inside `script`, `style`, `textarea` or `title`;
- attribute names are lowercased by the HTML parser;
- `when()` branches and `boundary()` fallbacks return templates, nodes or text,
  not another directive.

## Lists and branches

```ts
each(
  () => posts(),
  (post) => post.id,
  (post, index) => html`<article>${() => `${index()}: ${post().text}`}</article>`,
)
```

`each` passes the item as an accessor. A keyed item is rendered once; changing
the item object updates the accessor's readers without replacing the DOM.
Mutating an item in place does not notify; replace the object or use a signal.

`when(condition, onTrue, onFalse?)` swaps a branch only when the boolean flips.
Branch-local effects are disposed on replace.

## Ownership

Every mount, template instance, branch and item has an `Owner`. `effect()`,
event listeners, refs, timers and `resource()` register cleanup with the owner
that is current while they are created.

- `mount(container, render)` returns `{ element, dispose }`
- `onMount(fn)` runs after the current render is attached
- `onCleanup(fn)` registers with the current owner
- `legacy(node, dispose)` embeds an existing imperative component

Do not detach a live view and re-append it: an iframe loses its browsing
context. Keep it in the document and toggle `hidden` instead.

## Async data

```ts
const feed = resource((signal) =>
  fetch('/api/posts', { signal }).then((response) => response.json()),
);
```

Only the newest request commits; `refetch()` aborts the previous one and
`dispose()` aborts the active one. `boundary(render, fallback)` catches an error
thrown during the initial render.

## Development

```sh
npm install
npm test          # node --test + happy-dom
npm run typecheck
npm run build     # dist/render.js, dist/render.iife.js, dist/index.d.ts
```

Tests cover signals, templates, keyed reconciliation, lifecycle cleanup,
async resources and the rendered DOM identity of an iframe across a reorder.

## License

MIT. Extracted from the Flaxia client (`docs/rendering.md` in the main
repository describes the layout contract that sits on top of this engine).
