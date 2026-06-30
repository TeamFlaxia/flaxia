# Flaxia — Project Guide for Claude

## Project Identity
Flaxia is an SNS where posts are living, interactive applications. Concept: "Twitter with Flash inside" — spiritual successor to Adobe Flash.

## Tech Stack
- **Runtime**: Cloudflare Pages + Workers (edge-first)
- **API**: Hono framework (`hono/cloudflare-pages`)
- **Frontend**: Vanilla TypeScript SPA (Vite 5, no React)
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 (post payloads, images, audio)
- **Cache**: Cloudflare KV (game cache)
- **Auth**: Custom session-based auth (email/password, cookies, D1 sessions)
- **Queues**: Cloudflare Queues (ActivityPub delivery)
- **Package Manager**: pnpm
- **Test Runner**: Node native `--test` with `--experimental-strip-types`

## Two-Origin Architecture

| Origin | Purpose | Deployment |
|---|---|---|
| `flaxia.app` | SNS UI, API, timeline, D1, R2, KV | Cloudflare Pages |
| `sandbox.flaxia.app` | Executes untrusted ZIP/SWF/HTML5 in sandboxed iframes | Cloudflare Worker |

**Critical**: `allow-same-origin` is permanently banned on all iframes. Cross-origin communication only via typed postMessage bridge.

## Project Structure
```
functions/api/[[route]].ts  # Main API router (all endpoints)
src/main.ts                 # SPA entry point (~2500 lines)
src/components/             # UI components
src/lib/                    # Utilities (db, r2, bridge, sandbox, zip, etc.)
migrations/                 # D1 SQL migrations
tests/                      # Test files (*.test.ts)
.windsurf/rules/            # Detailed spec docs
docs/                       # Developer documentation
```

## Code Conventions
1. TypeScript strict mode — no `any`, no implicit any
2. Functions only, no classes
3. `kebab-case` files, `PascalCase` components/types
4. D1 queries: always prepared statements with `.bind()`
5. R2 keys namespaced: `payload/`, `gif/`, `avatar/`, `ad/`
6. Shared modules must be reused — no duplication between post/ad systems

## Constraints (NON-NEGOTIABLE)
- Post text ≤ 200 chars, payload ≤ 10MB
- Timeline: only (`ORDER BY created_at DESC`)
- `allow-same-origin` banned on all iframes
- `Sponsored` label mandatory on all ad cards
- `click_url` with `javascript:` scheme must be rejected
- White-first design, no dark backgrounds as base

## Security
- ZIP validation: client-side (JSZip) + server-side (file count, path traversal, forbidden types)
- Sandbox CSP: `default-src 'none'; script-src 'self'; connect-src 'none'; frame-ancestors https://flaxia.com`

## Testing
```bash
pnpm test                    # All tests
pnpm test:auth               # Auth tests
pnpm test:posts              # Posts tests
```

## Common Commands
```bash
pnpm dev                     # Build + wrangler pages dev
pnpm build                   # Vite build
pnpm deploy                  # Deploy to Pages
pnpm deploy:sandbox          # Deploy sandbox worker
pnpm migrate:local           # Run D1 migrations locally
pnpm migrate:prod            # Run D1 migrations in production
```

## Reference Docs
- `.windsurf/rules/rule.md` — Full project rules with DB schema, bridge types, design tokens
- `.windsurf/rules/flaxia-ad-spec.md` — Ad system specification
- `.windsurf/rules/zipexecution.md` — ZIP execution flow
- `.windsurf/rules/zipupload.md` — ZIP upload validation
- `docs/*.md` — Architecture, setup, deployment, API, database docs
