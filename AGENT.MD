# Flaxia

Chronological SNS where posts are living, interactive applications. "Twitter with Flash inside" — spiritual successor to Adobe Flash.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Pages + Workers (edge-first, no Node.js server) |
| API | Hono (`hono/cloudflare-pages`) |
| Frontend | Vanilla TypeScript SPA (Vite build) |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| KV | Cloudflare KV (game cache) |
| Auth | Custom session-based (cookie + D1 sessions) |
| Queues | Cloudflare Queues (ActivityPub delivery) |
| Languages | TypeScript strict mode (ES2022) |
| Package Manager | pnpm |

## Architecture (Two-Origin Model)

| Origin | Purpose |
|---|---|
| `flaxia.app` (main Pages) | SNS UI, API, timeline, database |
| `sandbox.flaxia.app` (sandbox) | Executes untrusted post content in isolated iframes |

### Key Rules
- `allow-same-origin` is **permanently banned** on all iframes
- All cross-origin communication via typed postMessage bridge (`src/lib/bridge.ts`)
- ZIP/SWF/HTML5 games run inside sandboxed iframes using blob URLs

## Project Structure

```
/
├── functions/          # Cloudflare Pages Functions (Hono API routes)
│   └── api/[[route]].ts  # Catch-all API router (~4000+ lines)
├── src/                # Client-side SPA
│   ├── components/     # UI components (PostCard, Timeline, etc.)
│   ├── lib/            # Utilities (db, r2, bridge, zip, etc.)
│   └── types/          # TypeScript type definitions
├── public/             # Static assets
├── sandbox/            # Sandbox origin (fresh-bridge.js)
├── migrations/         # D1 database migrations (35 files)
├── tests/              # Test suites
├── AGENT.MD            # This file
├── CLAUDE.MD           # Claude Code guidance
└── docs/               # Developer documentation
```

## Code Conventions
- TypeScript strict mode — no `any` escape hatches
- Functions only (no class components)
- File naming: `kebab-case` for files, `PascalCase` for exported components/types
- Prepared statements always for D1 queries
- Shared modules for sandbox rendering, R2 uploads — no duplication

## Important Constraints
- Post text: ≤ 200 characters
- Payload size: ≤ 10MB (post), ≤ 200MB (ads)
- Timeline: chronological only, no algorithmic sorting
- `allow-same-origin` banned on all iframes
- CSP enforced via HTTP headers (not `<meta>`)
- 3-column layout (240px / 600px / 350px)

## Detailed Specifications
See `.windsurf/rules/` for:
- `rule.md` — Project rules (identity, auth, DB, sandbox, API, design)
- `flaxia-ad-spec.md` — Ad slot specification
- `zipexecution.md` — ZIP execution flow
- `zipupload.md` — ZIP upload flow & validation
