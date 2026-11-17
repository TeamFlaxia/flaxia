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
- `DocsPage` uses the same shell composition and keeps its markdown-it/DOMPurify
  article renderer behind the captured article element;
- `SkeletonCard` / `SkeletonPost` are rendered with `html`/`mount` while keeping
  the existing skeleton class contract;
- `SearchPage` keeps persistent user/post/arcade/web sections. Each section is a
  keyed list, so a new query or filter change updates items in place instead of
  clearing the content area; the horizontal and grid Arcade variants share the
  same arcade signal;
- `ExplorePage` keeps posts, Arcade games and user suggestions in three keyed
  hosts. Post cards are wrapped with `legacy()` and disposed on filter change or
  unmount, while tag pages reuse the same post list;
- Arcade's game feed is a single-active swipe viewport, not a grid. Its comments
  list is keyed (`each` + `legacy`) for both flat and tree reply modes, with one
  mount per comment panel and generation-checked fetches;
- Profile's posts/freshs/bookmarks tabs share `UserPostList`, which now keeps a
  keyed post list. Initial load, paging, `addPost` and delete all update the
  signal, so existing cards (and their running stages) are reused;
- ThreadPage keeps its root card single, while the reply area is a keyed list for
  both flat and tree modes. New root replies append to the source list and
  re-render keyed entries; child replies stay in the source list for later tree
  rebuilds;
- MapsPage keeps its MapLibre canvas, but the WebGL fallback tile grid is keyed by
  z/x/y and the weather overlay is driven by loading/error/ready signals instead
  of `innerHTML`;
- MailPage keeps status states (login, locked, loading, error, empty) outside a
  keyed thread list. Folder/search changes reuse rows; read and star actions
  update the existing row instead of rebuilding the mailbox;
- MailThreadPage keeps its status, message list and reply composer in separate
  hosts. Messages are keyed by id, so a thread refresh reuses cards and their
  asynchronously rendered HTML/attachments;
- MailComposePage keys its attachment list by file identity, and
  MailSettingsPage renders its security rows through a keyed list;
- SettingsPage renders its panels through the engine: Titles and Custom Emoji
  are keyed lists (title id / stamp id, plus explicit empty/error/add entries);
  Display choice groups use `each` over the static option arrays; Language,
  Email, Password, Crowd and the Billing plan card are `html` templates with
  `ref`-captured inputs; the billing history is a keyed list (`left|right` row
  key) so a refresh reuses rows. All mounts are released in the page's
  `destroy()`. Three panels stay imperative on purpose: `VaultSection` (own
  setup/locked/unlocked state machine and timers), the Maps tile-cache panel
  (cache stats + persistence prompts) and `BugReportForm` (own form component).
  `tests/app-shell.browser.mjs` boots `/settings` with a stubbed signed-in
  session and asserts the rendered inputs, switches, language options and
  billing row;
- AdminUsersTab keys its user rows by `id:frozen-state`. Search reuses matching
  rows, freeze recreates only the changed row, and delete removes it through the
  engine. The empty state sits outside the keyed range;
- AdminHiddenTab keys hidden posts by post id. Restoring a post removes only that
  row through the signal, and the empty state is toggled outside the list;
- AdminAlertsTab keys report rows by alert id. Hide/dismiss removes only the
  affected row, while the NSFW and embedding controls stay outside the list;
- AdminAdsTab keys ad rows by `id:active-state`. Toggling active recreates only
  that row, and deleting removes it through the signal; the settings section and
  modal remain outside the keyed list;
- CSS is loaded through `src/styles/index.css`. Legacy `main.css` and
  `redesign/*` are in an explicit `legacy` layer; render primitives are in a
  later `primitives` layer. `main.ts` imports only that entry, and
  `tests/render/css-layers.test.ts` guards the order;
- media ratios are reserved with `.fx-box` rather than hand-rolled aspect
  tricks: PostStage ZIP/SWF (16/9 and 4/3), ImagePreview 16:9, the data-saver
  tap gate (16/9), link-preview thumbnails (1.914, 4 for the image-less banner)
  and image/video carousel slides (16/9). `src/styles/render/primitives.css`
  resets the legacy absolute fill and padding boxes. Video and audio players
  keep their existing fixed sizing. `tests/styles.browser.mjs` asserts the real
  geometry against the built CSS, and `tests/render/media-boxes.test.ts` covers
  the data-saver and link-preview components.
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
- `PostHeader` and `QuotedPostCard` compose their markup through `mount`/`html`
  and apply the shared helpers (plus badge, name colour, title badge, avatar
  loading) to `ref`-captured nodes. `PostActions` renders its reaction chips as
  a keyed `each` (emoji key); the action buttons and the positioned reload
  dropdown stay imperative because the dropdown owns document-level pointer and
  scroll listeners plus focus restore, and `PostCard` rebuilds the row only when
  its signature changes;
- the full-page loader was removed; `tests/render/guards.test.ts` prevents it
  and `#app.innerHTML = ''` from coming back;
- font loading uses `display=optional`, and desktop scrollbars reserve their
  gutter.

Remaining maintenance (not part of the stabilization contract above):

1. The PostCard tree is fully engine-rendered apart from `PostText`'s sanitized
   markdown payload (written as one `innerHTML` string by design) and the
   `PostActions` reload dropdown (document-level listeners + focus restore).
2. Cross-browser visual coverage: Chromium and Firefox now assert 390, 768, 900,
   1024 and 1400px in the app smoke, plus the built-CSS geometry smoke. WebKit
   runs the same two smokes in the `styles-webkit` CI job, but has never been
   executed locally (host libraries require `sudo playwright install-deps`).
3. Real-device CLS/LCP numbers using `?render-debug=1`. The headless budget
   already exists: `tests/app-shell.browser.mjs` installs
   `PerformanceObserver`s before any app script, delays the stubbed media by
   600ms, and asserts CLS < 0.02 and a recorded LCP for the timeline at
   1400x1000 and 390x844 and for `/settings` at 1400x1000. Current headless
   numbers are CLS 0.0000-0.0007 and LCP 80-550ms; the only measured shift is a
   ~22px move of the right-rail shortcuts block as its async content lands.

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

# Built-CSS layer/geometry smoke (uses dist/assets/main-*.css)
npm run test:styles:browser
STYLES_BROWSER=firefox npm run test:styles:browser
STYLES_BROWSER=webkit npm run test:styles:browser

# Real-app shell smoke: boots dist/ with a stubbed /api and blocked third parties
npm run test:app:browser
APP_BROWSER=firefox npm run test:app:browser
```

The renderer browser test checks keyed element identity, text-node identity,
in-place iframe browsing-context preservation, hidden-iframe preservation and
layout shift. The app smoke boots the real build at 1400x1000 (guest shell +
a stubbed timeline post for `PostHeader`/`PostActions`/`QuotedPostCard`, and
`/settings` for a signed-in user) at 390x844 (bottom nav on the viewport
edge, off-canvas left drawer, drawer open/close, right rail hidden, no
horizontal overflow) and across 768/900/1024px (drawer breakpoint stays sharp,
right rail hidden at and below 1024px, left nav in flow above 768px). A final
case records layout-shift and LCP entries with delayed media and enforces the
CLS budget at desktop and mobile. The styles smoke test loads the real build output, asserts both
`legacy` and `primitives` layers, verifies that `primitives` wins on a
same-specificity probe, and checks a 16:9 `.fx-box` geometry. Chromium and
Firefox run locally; the `styles-webkit` CI job installs WebKit with
`playwright install --with-deps webkit` and runs the same smoke test. The app
shell smoke asserts that the real build still renders the 240px / content /
350px shell from the layered stylesheet, without the initial loader and without
horizontal overflow; it also runs under WebKit in CI.
