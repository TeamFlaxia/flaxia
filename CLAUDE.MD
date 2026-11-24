# Flaxia — Project Guide for Claude

## Project Identity
Flaxia is an SNS where posts are living, interactive applications. Concept: "Twitter with Flash inside" — spiritual successor to Adobe Flash.

## Tech Stack
- **Runtime**: Cloudflare Pages + Workers (edge-first)
- **API**: Hono (`functions/api/[[route]].ts` mounts `functions/api/routes/*`)
- **Frontend**: SvelteKit 5 with SSR (`@sveltejs/adapter-cloudflare`), TypeScript
- **Styling**: legacy CSS skin (`src/styles/main.css` + `legacy/`) with Svelte scoped styles for migrated components. Tailwind v4 is installed and `src/app.css` mirrors the tokens, but it is **not imported** (the app CSS must stay unlayered; see `tests/app-shell.browser.mjs`).
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 (post payloads, images, audio, avatars)
- **Cache**: Cloudflare KV
- **Auth**: custom SRP/session auth (cookies + D1 sessions); `flaxia-auth` is a separate service for native/Auth deployments
- **Queues**: Cloudflare Queues (ActivityPub delivery)
- **Package Manager**: npm (not pnpm)
- **Test Runner**: Node native `--test` with `--experimental-strip-types`

## Two-Origin Architecture

| Origin | Purpose | Deployment |
|---|---|---|
| `flaxia.app` | SNS UI, API, D1, R2, KV | Cloudflare Pages |
| `sandbox.flaxia.app` | Executes untrusted ZIP/SWF/HTML5 in sandboxed iframes | Cloudflare Worker |

**Critical**: `allow-same-origin` is permanently banned on all game iframes. Cross-origin communication only via the typed postMessage bridge (`src/lib/bridge.ts`).

## Project Structure
```
src/routes/                 # SvelteKit routes (SSR pages + +server.ts endpoints)
src/lib/svelte/             # Migrated Svelte surfaces (ShellLayout, Timeline, Settings, Admin, Mail, ...)
src/components/             # Remaining legacy DOM factories (Arcade engine, PostText, modals, ...)
src/lib/                    # Client utilities (i18n, navigation, upload, vault, recommendation, ...)
src/styles/                 # legacy CSS + redesign CSS + overrides
functions/api/[[route]].ts  # Thin Hono router
functions/api/routes/       # Feature routers (posts, media, stamps, admin, ...)
functions/lib/              # Server helpers + ports/adapters
functions/lib/ports/        # Platform-neutral interfaces (Db/Kv/BlobStore/Queue/...)
functions/lib/adapters/     # Cloudflare implementations
shared/                     # Contracts shared by client and Worker
packages/flaxia-render/     # Legacy render engine still used by PostText/PostStage
migrations/                 # D1 SQL migrations
tests/                      # Node test files and Playwright browser tests
docs/                       # Developer documentation
```

## Frontend Conventions
- Routes own the shell and session gate; legacy DOM stays behind `.ts` adapters, never called from `.svelte`.
- `LEGACY_ADAPTERS.md` is a shrinking ratchet enforced by `tests/legacy-adapters.test.ts`; it is currently empty.
- Navigation always goes through `src/lib/navigation.ts` (`goto`), never `history.pushState`.
- Use Svelte 5 runes; remember `$derived` values are values, not functions.
- Uploads: 25MB/file free, 128MB/file Flaxia+; files above 25MB use the chunked transport in `src/lib/upload.ts`.
- Shell geometry: centred left 240–350px / centre 600px / right 350px; the right rail is hidden below 1200px and on surface pages.
- Keep `functions/** → src/**` imports at 0; share through `shared/`.

## Constraints (NON-NEGOTIABLE)
- Post text ≤ 200 chars. Free uploads ≤ 25MB/file; Flaxia+ ≤ 128MB/file (256MB per post).
- Global and Following timelines: reverse chronological (`GET /api/posts`). For You: ranked (`GET /api/posts/recommended`); see `docs/architecture.md`.
- `allow-same-origin` banned on all game iframes.
- `Sponsored` label mandatory on all ad cards.
- `click_url` with `javascript:` scheme must be rejected.
- Legacy/redesign CSS must stay unlayered (no `@layer`) because `index.html` inlines unlayered critical CSS.
- Server-side upload, scan and ownership checks are authoritative; client checks are only UX.

## Security
- ZIP policy is enforced server-side by `functions/lib/wvfs-zip-server.ts` (entry count/paths/types, expanded size 512MB, entry 100MB).
- Uploads run magic-byte, dimension, blocklist and (≤25MB) ClamAV checks; chunked uploads also recover the ZIP structure hash via R2 range reads.
- Sandbox CSP is applied by the sandbox Worker; never weaken the main-origin CSP.

## Testing
```bash
npm run test:group -- guardrails   # no dev server required
npm run test:group -- posts-feeds  # requires local wrangler stack
npx tsc --noEmit
npx @biomejs/biome ci .
node scripts/check-file-size.mjs
npm run build
npm run test:render
```
Integration suites need `npm run migrate:local`, `npm run dev:do`, `npm run dev:multiplayer` and `npm run dev:test` (port 8788). Browser suites use Playwright in CI (`npm run test:app:browser`, `npm run test:styles:browser`).

## Common Commands
```bash
npm run dev            # Vite + wrangler Pages dev
npm run build          # static build + CSP/SSR head generation
npm run deploy         # deploy dist to Cloudflare Pages
npm run deploy:sandbox # deploy the sandbox worker
npm run migrate:local  # apply D1 migrations locally
npm run migrate:prod   # apply D1 migrations in production
```

## Reference Docs
- `docs/architecture.md` — runtime/UI architecture
- `docs/api.md` — API contract
- `docs/file-scanning.md` — upload scanning pipeline
- `docs/sandbox.md` — game sandbox and WVFS
- `docs/architecture/platform-neutrality.md` — Ports/Adapters and CI ratchet
