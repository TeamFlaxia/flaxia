# Visual parity against `main`

The renderer work was verified with behaviour tests (keyed lists, mounts, CLS
budgets) but those could not tell whether the app still *looked* like `main`.
That gap let a real regression through: wrapping the app CSS in
`@layer legacy, primitives` made every app stylesheet lose to the unlayered
critical CSS inlined in `index.html`, so the shipped page silently fell back to
the pre-redesign values (240px nav, 1200px container, post cards without
padding). The unit and browser smokes still passed because they asserted the
broken numbers.

`tests/visual-parity.mjs` closes that gap. It serves a built `dist/` with a
stubbed API, then records screenshots plus computed styles for the main routes,
so two builds can be compared numerically.

## Running it

```bash
# 1. baseline: the merge-base of the branch (origin/main) in a worktree
git worktree add /tmp/flaxia-base origin/main
ln -s "$PWD/node_modules" /tmp/flaxia-base/node_modules
(cd /tmp/flaxia-base && npx vite build)

# 2. capture both builds
node tests/visual-parity.mjs --dist /tmp/flaxia-base/dist --out /tmp/parity/base --label base
node tests/visual-parity.mjs --dist dist --out /tmp/parity/head --label head

# 3. compare (>1px layout deltas or any computed-style change fails)
node tests/visual-parity.mjs --diff /tmp/parity/base/base.json /tmp/parity/head/head.json
```

Routes: `/`, `/explore`, `/arcade`, `/maps`, `/notifications`, `/bookmarks`,
`/search`, `/profile/<user>`, `/thread/<id>`, `/mail`, `/mail/new`, `/settings`,
`/admin`, `/docs`, `/terms`, `/download` at 1400x1000, plus `/`, `/explore` and
`/settings` at 390x844. The stub returns a post with a quote, reactions, media,
mentions and a hashtag so the post card, header, actions and quote are covered.

Sub-pixel text widths (`50.2188px` vs `50.2344px`, 1/64px rounding) are treated
as equal; layout deltas above 1px and any other style change fail. `textContent`
is not compared, because the engine keeps harmless block-level whitespace text
nodes (for example between the legal page's header and body).

## Recorded result (branch vs `origin/main`)

At 19 routes the comparison prints:

```
no layout/style differences
```

The shipped values it locks in:

| Element | Value |
|---|---|
| `.main-container` | `max-width: 1220px`, centred |
| `.left-nav` | 290px (72px icon rail at 769-1199px, off-canvas drawer <= 768px) |
| content column | 640px |
| `.right-panel` | 290px, hidden <= 1024px |
| `.post-card` | `padding: 13px 14px`, `margin: 0 8px`, `border-radius: 12px` |
| `.right-card` | `padding: 10px`, `border-radius: 12px` |
| body | `line-height: 25.5px`, 15px type scale |

`tests/app-shell.browser.mjs` asserts these same numbers (and that the shipped
CSS contains no `@layer` block), so a future cascade change fails in CI instead
of only in the browser.

## Runtime errors

The parity harness also records console and page errors. The branch must not add
any: `node tests/visual-parity.mjs` over the route list was compared with the
baseline and now reports no head-only errors. The three that it did catch were
fixed:

- `/maps` — `currentWeatherPoint()`/`nextClearPoint()` read `points` from a
  payload that may omit it;
- `/thread/<id>` — a thread payload without `replies`/`root` threw a `TypeError`;
- `/profile/<user>` — a user payload without `user` threw while reading
  `frozen`.

Remaining console noise in the harness comes from blocked third-party requests
(fonts, AdSense, the crowd node) and from the stubbed API answering module or
WebSocket requests with JSON; the same messages appear on `origin/main`.
