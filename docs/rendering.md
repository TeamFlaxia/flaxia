# Rendering

Flaxia's SNS UI uses a small rendering engine extracted as
[`flaxia-render`](../packages/flaxia-render/README.md). It is deliberately not a
general-purpose framework: it provides fine-grained updates, keyed lists and
explicit ownership so a feed can refresh without recreating the iframes, videos
and inputs inside its cards. Reordering moves existing elements; browsers may
reset an iframe's browsing context when its DOM position changes, so the safe
case is an in-place update that keeps the order.

The implementation lives in `packages/flaxia-render/`. Flaxia imports it through
`src/lib/render/index.ts`, a one-line re-export boundary; replacing that line
with `export * from 'flaxia-render'` is the only change needed when the package
is published.

The game runtime is unchanged. ZIP/SWF/HTML5 content still executes in the
sandbox origin under the rules in [`docs/sandbox.md`](sandbox.md); this engine
only decides where the reserved box is and keeps it mounted.

## Why it exists

The previous view layer cleared `#app` on every navigation and rebuilt the DOM
from scratch. It also replaced a post's stage element when the user toggled
playback, which destroyed the iframe and its blob URLs. The observable symptoms
were a blank content column, scroll jumps and games reloading.

The engine makes three guarantees:

1. The first render of a subtree is inserted in one `replaceChildren()` call.
2. An update touches only the parts whose signals changed.
3. A keyed item keeps its DOM node across reorder, insert and update. In-place
   updates (no reorder) keep an iframe's browsing context; a browser may reset it
   when the element is moved.

## Core API

```ts
import { each, html, mount, signal, when } from 'flaxia-render';

const open = signal(false);

const view = html`
  <article class="post-card">
    <h2>${() => post.title}</h2>
    ${when(open, () => html`<p>${() => post.body}</p>`)}
    ${each(
      () => replies(),
      (reply) => reply.id,
      (reply, index) => html`<p>${() => `${index()}: ${reply().text}`}</p>`,
    )}
  </article>
`;

const mounted = mount(container, () => view);
open.set(true);
mounted.dispose();
```

### Reactivity

| Export | Purpose |
|---|---|
| `signal(value)` | Read with `value()`, write with `value.set(next)` or `set(previous => next)`. `peek()` reads without tracking. |
| `computed(fn)` | Lazy, cached value. Recomputes when a dependency version changes. |
| `effect(fn)` | Runs immediately, then in a microtask after a write. The returned cleanup runs before the next run and on dispose. |
| `batch(fn)` | Coalesces writes into one flush. |
| `untrack(fn)` | Reads inside are not tracked. |
| `flushEffects()` | Test/synchronous hand-off helper. |

### Templates

`html` compiles once per call site and clones a `<template>`. These bindings are
supported; the interpolation must occupy the **entire** value:

```ts
html`<div class=${className} title="${title}">`
html`<input .value=${() => draft()}>`
html`<button ?disabled=${() => busy()} @click=${save}>`
html`<canvas ref=${(element) => { canvas = element; }}>`
```

- A function in a child or normal attribute position is an **accessor** and is
  subscribed with `effect()`. A function in an event position is the handler.
- Attribute names are lowercased by the HTML parser; write `data-foo`, not
  `data-Foo`.
- Spread (`...${props}`) and attribute-name interpolation are not supported.
- Child interpolation inside `script`, `style`, `textarea` and `title` is not
  supported; use a property binding such as `.value`.
- A `when()` branch or `boundary()` fallback must return a template, node or
  text, not another directive.
- Interpolated values are always written with DOM APIs (text nodes, attributes,
  properties). A post containing `<img onerror=...>` is rendered as text.

### Structural directives

`each(items, key, render)` passes the item as an **accessor**. Read it inside a
binding so an update changes only that text/attribute:

```ts
each(
  () => posts(),
  (post) => post.id,
  (post) => html`<article data-id=${post().id}>${() => post().text}</article>`,
)
```

Reusing a key preserves the rendered nodes; changing the item object updates the
accessor's readers. Mutating an item in place (same object identity) does not
notify; replace the object or update a signal.

`when(condition, onTrue, onFalse?)` swaps a branch only when the boolean flips.
Both branches run in their own owner, so effects created by a branch are disposed
when it is replaced.

### Ownership and lifecycle

Every mount, template instance, `when` branch and `each` item has an `Owner`.
`effect()`, event listeners, refs, timers and `resource()` register their cleanup
with the owner that is current while they are created. `dispose()` releases the
whole subtree.

- `mount(container, render)` returns `{ element, dispose }`.
- `onMount(fn)` runs after the current render is attached.
- `onCleanup(fn)` registers with the current owner.
- `legacy(node, dispose)` embeds an existing imperative component. This is the
  only migration boundary; keep it visible in review.

Do not detach a live view with `removeChild` and re-append it: an iframe loses its
browsing context. Keep the pane in the document and toggle `hidden` instead.

### Async data

```ts
const feed = resource((signal) => fetch('/api/posts', { signal }).then((r) => r.json()));
```

Only the newest request commits; `refetch()` aborts the previous one, and
`dispose()` aborts the active one. `boundary(render, fallback)` catches an error
thrown during the initial render so one card cannot blank a view.

## Layout contract

`src/lib/layout/box.ts` and `src/styles/render/primitives.css` define `.fx-box`:
a positioned element with `aspect-ratio`, `min-height`, `contain: layout paint`
and `overflow: clip`. Use `MediaBox`/`Skeleton` for every media, game, ad and
preview slot.

Rules:

- The box owns its outer size; the child fills it.
- A slot inserted after first paint must not change the height of its ancestors.
  Reserve ad and preview slots at initial render.
- Images use `width`/`height` attributes when available, plus the box ratio.
- Do not append ad placeholders while the user is scrolling through existing
  cards.
- `content-visibility: auto` only below the first viewport, and always with
  `contain-intrinsic-size`.
- Fonts: self-host with `unicode-range` and `font-display` chosen per surface;
  a late font swap is a layout shift.

## Diagnostics

Open the app with `?render-debug=1` (or set
`window.__FLXIA_RENDER_DEBUG__ = true` before the app boots). The page records:

- CLS with the moved node (`layout-shift` sources),
- long tasks,
- LCP,
- reserved boxes that changed height after mount.

Use `window.__flaxiaRender.report()` for the current report and
`.audit()` to re-check boxes. The diagnostics module is a no-op without the
flag.

## Migration status

Implemented:

- engine extracted to `packages/flaxia-render/` (`flaxia-render`), with its own
  build, tests and README; Flaxia consumes it through `src/lib/render/index.ts`;
- engine core, tests, keyed lists, async resources, error boundary;
- layout primitives and the `fx-box` contract;
- opt-in diagnostics;
- `PollWidget` migrated; voting updates the widget in place instead of replacing
  it;
- `BookmarksPage` uses a keyed `each()` for its post list. Existing `PostCard`
  instances are wrapped with `legacy()`; appending a page reuses the current
  cards, and removing/unmounting disposes them through the engine owner;
- `NotificationsPage` uses the same keyed `each()` + `legacy()` pattern for
  notification rows. Mark-all-read mutates the existing rows, and `destroy()`
  disposes the list mount;
- `BillingResultPage` and `DownloadPage` render through `mount()`/`html`.
  DownloadPage keeps its platform-card helpers as Node values, and both pages
  dispose their mount on `destroy()`;
- `LegalPage` composes its header, article and footer through `mount()`; the
  async markdown loader writes into the captured article element;
- `viewport-fit=cover` so `env(safe-area-inset-*)` reports real values on iOS;
- navigation builds the next view in a detached staging root and swaps it in one
  `replaceChildren()`, so the content column is not blanked and a newer
  navigation cannot be overwritten by an older one;
- the whole current view is parked in a hidden in-document host when opening a
  thread or Arcade, then restored without rebuilding. Iframes keep their
  browsing context and the timeline scroll position is preserved;
- `PostStage` keeps a preview layer and an execution layer. Switching back to the
  preview hides the execution layer instead of clearing it, so the game iframe
  and its blob URLs survive; `PostCard.destroy()` releases the handles;
- `Timeline` reuses cards by post id and moves only the nodes whose position
  changed; ads and link previews reserve their box before loading;
- the full-page loader was removed; `tests/render/guards.test.ts` prevents it
  and `#app.innerHTML = ''` from coming back;
- font loading uses `display=optional`, and desktop scrollbars reserve their
  gutter.

Remaining maintenance (not part of the stabilization contract above):

1. Page-by-page migration of the remaining components (PostCard internals,
   Settings, Admin, Mail, Maps, etc.) to the renderer.
2. CSS layer consolidation and a full cross-browser visual matrix.
3. Real-device CLS/LCP measurement using `?render-debug=1`.

## Tests

```sh
npm run test:render          # app + package unit tests (happy-dom)
npm run build:render         # packages/flaxia-render/dist (ES + IIFE + .d.ts)
(cd packages/flaxia-render && npm test)

# Optional real-browser check; install Playwright without saving it first.
npm install --no-save --package-lock=false --ignore-scripts playwright@1.62.1
npx playwright install chromium firefox
npm run test:render:browser
RENDER_BROWSER=firefox npm run test:render:browser
```

The browser test checks keyed element identity, text-node identity, in-place
iframe browsing-context preservation, hidden-iframe preservation and layout
shift. Chromium and Firefox are covered; WebKit needs the host libraries listed
by `npx playwright install webkit` (libicu, flite, gstreamer) and is optional.
