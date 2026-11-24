# SSR / no-JS Plan

## Overview

Flaxia is a SvelteKit 5 app rendered with `@sveltejs/adapter-cloudflare` on the
same Cloudflare Pages project that hosts the API. Every request receives real
HTML from the server, so search engines, social cards and clients without
JavaScript get the same content as a browser.

The previous design — a `User-Agent` crawler check in Pages Functions that
rendered a separate HTML document — has been removed. UA sniffing was fragile
(new bots were missed, spoofed UAs got a different document) and duplicated the
metadata pipeline.

## Architecture

```
Client (browser / crawler / no-JS)
  └── Cloudflare Pages
        └── _worker.js (SvelteKit SSR)
              ├── src/hooks.server.ts        security headers, locale, AP redirects
              ├── src/routes/**/+page.server.ts  D1-backed data via the Hono app
              ├── src/routes/**/+page.svelte     server-rendered markup
              └── src/routes/api/**/+server.ts   JSON API (legacy Hono app)
```

## Principles

- **One renderer.** `+page.svelte` runs on the server and hydrates in the
  browser. There is no separate crawler template to keep in sync.
- **Metadata is per route.** `+page.server.ts` returns data; `<svelte:head>` and
  the page markup derive titles, descriptions and links from it.
- **No-JS is a first-class client.** `SsrOnly` / `SsrPostList` render posts,
  profiles and game lists during SSR, then hand over to the interactive
  components after hydration.
- **CSP is generated, not hand-maintained.** `vite.config.ts` sets
  `csp.mode = 'auto'`; SvelteKit emits a nonce in the response header and the
  inline bootstrap. Static inline scripts that run inside blob/sandboxed
  iframes are allowlisted by hash.
- **Data saver stays client-side for media** (`src/lib/settings.ts`), while SSR
  guarantees the initial document already contains readable content.

## Routes with SSR data

| Route | Source | Notes |
|---|---|---|
| `/home` | `GET /api/posts` | `Cache-Control: private, no-store` (following feed shares the route) |
| `/thread/[id]` | `GET /api/posts/:id/thread` | root + replies |
| `/users/[username]` | `GET /api/users/:username`, `GET /api/posts?username=` | profile header + recent posts |
| `/arcade` | `GET /api/games` | game cards |
| `/arcade/[id]` | `GET /api/games` + thread | game title and post content |

All loads go through `src/lib/server/ssr-data.ts`, which calls the Hono app
in-process. That keeps SSR and client payloads identical without duplicating SQL.

## ActivityPub

`/actors/:username`, `/actors/:username/{outbox,followers,following,liked,featured}`,
`/notes/:id` and `/users/:username/inbox` are redirects. Static rules live in
`_redirects`; parameterised ones live in `src/hooks.server.ts` because
adapter-cloudflare cannot express `:param` rules in `_routes.json`.

## Verification

- `npm run typecheck`
- `npm run build` → `.svelte-kit/cloudflare/_worker.js`
- `npm run dev:test` (port 8788) then `curl` `/home`, `/thread/:id`,
  `/users/:username`, `/arcade` and check that the HTML contains post text and
  `Content-Security-Policy: ... 'nonce-...'`.
- Disable JavaScript in the browser and reload: the feed, thread and profile are
  readable, and the "Loading Flaxia…" spinner no longer exists.
