You are a senior engineer associate with Flaxia.

# Flaxia

SNS where posts are living, interactive applications. "Twitter with Flash inside" — spiritual successor to Adobe Flash.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Pages + Workers (edge-first, no Node.js server) |
| API | Hono (`hono/cloudflare-pages`), mounted from `functions/api/[[route]].ts` |
| Frontend | Vanilla TypeScript SPA (Vite build, no framework) |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| KV | Cloudflare KV (game cache) |
| Auth | Custom session-based (cookie + D1 sessions) |
| Payments | Stripe (subscriptions; Flaxia+ only) |
| Queues | Cloudflare Queues (ActivityPub delivery) |
| Languages | TypeScript strict mode (ES2022) |

Package manager: the repo targets Node.js 22. Use `npm` for the documented
scripts (`package.json` has a `packageManager: pnpm` field, but all scripts and
CI run with npm).

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
├── functions/                 # Cloudflare Pages Functions
│   ├── api/[[route]].ts       # Thin Hono router that mounts route modules
│   ├── api/routes/*.ts        # Feature routers (posts, media, stamps, ...)
│   ├── api/billing/[[route]].ts  # Stripe subscription checkout/webhook/portal
│   ├── api/market/checkout.ts    # Flax-market checkout (backend only)
│   └── lib/                   # Server-side helpers (auth, billing, crowd, ...)
├── src/                       # Client-side SPA
│   ├── components/            # UI components (PostCard, Timeline, SettingsPage, ...)
│   ├── lib/                   # Utilities (i18n, bridge, zip, settings, ...)
│   └── types/                 # TypeScript type definitions
├── public/                    # Static assets + locales/{en,ja}.json
├── sandbox/                   # Sandbox origin (fresh-bridge.js)
├── migrations/                # D1 migrations (SQL, applied in order)
├── tests/                     # Node native test suites (*.test.ts)
├── AGENTS.md                  # This file (OpenCode reads this)
├── CLAUDE.MD                  # Claude Code guidance (separate, update manually)
└── docs/                      # Developer documentation (see docs/billing.md)
```

## Code Conventions
- TypeScript strict mode — no `any` escape hatches
- Functions only (no class components)
- File naming: `kebab-case` for files, `PascalCase` for exported components/types
- Prepared statements always for D1 queries
- Shared modules for sandbox rendering, R2 uploads, billing — no duplication
- New API routes go in `functions/api/routes/*.ts` and are mounted in `functions/api/[[route]].ts`

## Important Constraints
- Post text: ≤ 200 characters
- Payload size: ≤ 10MB (post), ≤ 200MB (ads)
- Timeline: only, no algorithmic sorting
- `allow-same-origin` banned on all iframes
- CSP enforced via HTTP headers (not `<meta>`)
- 3-column layout (240px / 600px / 350px)

## Billing (Stripe)
- Only **Flaxia+** is sold. `flaxia_plus_plus` / `flaxia_sharp` exist in the DB but are not offered.
- Key files: `functions/lib/billing.ts`, `functions/api/billing/[[route]].ts`, `src/components/SettingsPage.ts`.
- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FLXIA_PLUS` (see `docs/billing.md`).
- Never hard-code or log secrets. Webhook events are made idempotent via the `stripe_events` table.

## E2EE (Personal Vault)

Personal data at rest — drafts, private notes, personal settings — is encrypted
in the browser. Posts and media stay plaintext on purpose (ActivityPub,
SSR/SEO, vector search, push need them).

**`docs/e2ee.md` is the spec: code that contradicts it is a bug.**

- Key hierarchy: `password →PBKDF2-SHA256(600k)→ KEK`, `recovery phrase → REK`,
  and a per-device non-extractable key all wrap **VK**; VK wraps one
  `item_key` per item; `item_key` AES-256-GCM-encrypts the payload.
- The server stores only wrapped blobs (`vault_keys`, `device_keys`,
  `vault_items` — migration `0091`) and must never derive, unwrap, or see a
  key, password, or recovery phrase. Enforced by `tests/security-guards.test.ts`.
- Enabling/rotating the vault requires an SRP account plus a `current_srp`
  proof; `PUT` is version-checked via `vk_version`.
- A password change must re-wrap VK in the same request (`vault_kek`) or it is
  rejected with 409 `vault_rewrap_required` — an envelope wrapped around the
  old password would be unreachable.
- All new auth code is SRP-6a; the KDF id lives in `users.srp_kdf`
  (`sha256-v1` → `pbkdf2-600k-v2`, migration `0090`) and is an **allowlist**.
- Legacy `POST /api/auth/login` exists only for pre-SRP accounts. Delete it
  when `GET /api/admin/auth-migration` reports `cutoff_reached`.
- `src/lib/srp.ts` and `functions/lib/srp.ts` must stay **byte-identical**
  (`tests/srp-copy.test.ts`).

---

## Commands

```bash
npm run dev           # migrate + vite build + wrangler pages dev
npm run build         # vite build (also builds SDK/capture)
npm run typecheck     # tsc --noEmit
npm run lint          # biome check .
npm run migrate:local # apply D1 migrations locally
npm test              # all test suites (needs dev:test server; see below)
npm run test:billing  # billing tests only
```

Tests run against a local server started separately:

```bash
npm run dev:test      # port 8788, ENVIRONMENT=test
npm run test:billing  # in another shell
```

## Detailed Specifications
See `docs/` for architecture, setup, deployment, API, database, and billing documentation. Encryption, key hierarchy, and the plaintext-password retirement are specified in `docs/e2ee.md`.
