# Service map

- Status: current topology + the approved mail split
- Updated: 2026-11-23
- Related: `TODO.md` (全体プラン / 分割判断基準),
  `docs/architecture/platform-neutrality.md`, `docs/deployment.md`,
  `docs/architecture.md`

Flaxia is one product built from several independently deployed services. The
SNS core (`posts` / `users` / `admin` / feed / ActivityPub) intentionally stays
inside this repository as a monolith; auth, mail, and Crowd are already separate
deploy units with their own repositories. This document records which service
owns which data so a future split (or a rollback) has a fixed reference.

## Repositories

| Repo | Deploy unit / origin | Data ownership (D1 / R2 / KV / DO / queues) | Secrets of note | Deploy trigger | Owner / status |
|---|---|---|---|---|---|
| `flaxia` (this repo) | Pages app `flaxia` → `https://flaxia.app` | D1 `flaxia`, R2 `flaxia-content`, KV `CACHE`, Vectorize `flaxia-posts-768`, queue `activitypub-delivery`, DO namespaces bound from `notif-stream` / `multiplayer-worker` | `MAIL_INTERNAL_SECRET`, `CROWD_API_KEY`, `CROWD_WEBHOOK_SIGNING_SECRET`, `GITHUB_APP_*`, `STRIPE_*`, `VAPID_*` | GitHub Actions `deploy-pages` in `.github/workflows/deploy.yml` after CI on `main` | SNS core; intentionally a monolith |
| `TeamFlaxia/flaxia-auth` | Worker `flaxia-auth` → `https://auth.flaxia.app`; trusted surface `FlaxiaBridge` (bound as `AUTH_SERVICE`) | D1 `flaxia-auth-prod` | Auth/OAuth signing material and the auth-side secrets documented in that repo | `flaxia-auth` CI `deploy` job on `main` | Production credential authority since 2026-10-30 (`AUTH_AUTHORITY_MODE=flaxia-auth`) |
| `TeamFlaxia/flaxia-mail` (new) | Worker `flaxia-mail` + `@flaxia/mail-contract` (vendored tarball `flaxia/vendor/flaxia-mail-contract-0.1.1.tgz`; never uploaded to the npm registry); no `workers.dev` route (Service Binding + Email Routing only) | D1 `flaxia-mail`, R2 `flaxia-mail-content`, queues `flaxia-mail-queue` / `flaxia-mail-dlq` | `MAIL_INTERNAL_SECRET`, `MAIL_THREAD_SECRET` | `flaxia-mail` CI `deploy-worker` job on `main`; contract releases are git-tagged `contract-vX.Y.Z` | Split approved; the Worker has moved out of this repo. Apex cutover 2026-11-07 |
| `TeamFlaxia/flaxia-crowd` | Orchestrator → `https://crowd.flaxia.app` | Crowd-owned orchestration state (not Flaxia D1) | `CROWD_API_KEY`; webhook signing secret (set on both sides) | `release.yml` builds `node-vX.Y.Z` / `sdk-vX.Y.Z` GitHub Releases (never uploaded to the npm registry); orchestrator deploy is not part of this repo's workflow | Active; Flaxia vendors `@flaxia/node` 0.10.0 from `vendor/` and serves its browser bundle same-origin at `/crowd/v0.10.0-0/` |
| `TeamFlaxia/friedflaxia` | No separate deploy unit; vendored as wasm into `flaxia-crowd` at a pinned commit | — | — | Built/pinned by `flaxia-crowd` | Active |
| `flaxia-studio` | Separate app repo | Out of scope here | Out of scope here | Own repo | Out of scope (another AI is working on it) |
| `theia` | Separate private repo | Out of scope here | Out of scope here | Own repo | Out of scope (another AI is working on it) |
| `flaxia-developer-portal` | Separate repo; deploy unit and origin are not part of this repo's deploy graph | Not owned by `flaxia` | Not managed from this repo | Not documented in this workspace | Separate repo; out of scope for this pass |

## Deploy units inside the `flaxia` repo

| Deploy unit | Config / entry | Origin | Data it touches directly | Deploy job |
|---|---|---|---|---|
| Pages app `flaxia` | `wrangler.toml`, `functions/api/[[route]].ts` | `flaxia.app` | D1 `flaxia`, R2 `flaxia-content`, KV `CACHE`, Vectorize `flaxia-posts-768` | `deploy-pages` |
| `flaxia-sandbox` | `wrangler.sandbox.toml`, `src/sandbox-worker.ts` | `sandbox.flaxia.app` | D1 `flaxia`, R2 `flaxia-content` | `deploy-sandbox` |
| `flaxia-ap-delivery` | `wrangler.worker.toml`, `functions/queue-worker.ts` | No public origin (queue consumer + cron) | D1 `flaxia`, R2 `flaxia-content` / `flaxia-exports`, KV `CACHE` / `EXPORT_KV`, queue `activitypub-delivery` (+ DLQ) | `deploy-queue` |
| `notif-stream` | `do-worker/wrangler.toml` | Durable Object worker only | Durable Object storage (notification streams) | `deploy-do` |
| `multiplayer-worker` | `multiplayer-worker/wrangler.toml` | Durable Object worker only | Durable Object storage (rooms, matchmaking) | `deploy-multiplayer` |

The Mail Worker is no longer a deploy unit in this repo. Flaxia keeps only the
Pages proxy, the SPA UI, and `MAIL_SERVICE`; the Worker, its migrations, and its
D1/R2/queues live in the `flaxia-mail` repo.

## Distribution

Nothing Flaxia ships is published to the npm registry. Packages stay public (no
`private` flag) and a `prepublishOnly` script refuses to publish. Two channels
remain, and both carry the same bytes:

- **Committed tarball** in the consumer repo, referenced as a `file:` dependency:
  `flaxia/vendor/flaxia-node-0.10.0.tgz`, `flaxia/vendor/flaxia-sdk-0.8.0.tgz`,
  `flaxia/vendor/flaxia-mail-contract-0.1.1.tgz`.
- **GitHub Release asset** from the producer repo: `node-vX.Y.Z` /
  `sdk-vX.Y.Z` (assets `flaxia-node-X.Y.Z.tgz` / `flaxia-sdk-X.Y.Z.tgz`) in
  `flaxia-crowd`, and `contract-vX.Y.Z` in `flaxia-mail`.

The Game SDK is not distributed as a package at all: it is served inside the
sandbox at `/sdk/game.js` (IIFE, global `FlaxiaGame`) as part of the sandbox
deploy. The Crowd browser node bundle is likewise in-app: the Pages build copies
`node_modules/@flaxia/node/dist` to `dist/crowd/v0.10.0-0/`, so it is same-origin,
path-versioned, and immutably cached. There is no unpkg asset proxy; only
`/api/crowd/webhook` and `/api/crowd/scan-file` remain as Crowd routes, and
`unpkg.com` in CSP is for Ruffle alone.

## Dependency diagram

```
                         ┌─────────────────────────────┐
                         │  flaxia.app (Pages)         │
                         │  SPA + Hono API             │
                         └───┬───────┬───────┬─────────┘
                             │       │       │
             AUTH_SERVICE    │       │       │  HTTPS (webhook / scan-file only)
                             v       │       v
                  ┌──────────────┐   │   ┌──────────────────────┐
                  │ flaxia-auth  │   │   │ crowd.flaxia.app     │
                  │ D1: -prod    │   │   │ @flaxia/node @flaxia │
                  └──────────────┘   │   │ /sdk + friedflaxia   │
                                     │   └──────────────────────┘
                    MAIL_SERVICE     v
                  ┌──────────────────────────┐
                  │ flaxia-mail              │
                  │ D1 + R2 + queues + SMTP  │
                  └──────────────────────────┘

  shared inside the flaxia repo:

  D1 flaxia ─────────► Pages app
            ├────────► flaxia-ap-delivery
            └────────► flaxia-sandbox

  R2 flaxia-content ─► Pages app, flaxia-ap-delivery, flaxia-sandbox
  KV CACHE ──────────► Pages app, flaxia-ap-delivery, flaxia-sandbox
  AP_DELIVERY_QUEUE ─► flaxia-ap-delivery (consumes activitypub-delivery)
  NOTIFICATION_STREAM► notif-stream
  MULTIPLAYER_ROOM ──► multiplayer-worker
  MATCHMAKER ────────► multiplayer-worker
```

## Split criteria

A domain is ready to leave this repository when all three are true (same bar as
the `flaxia-auth` MVP, see `TODO.md` 「将来、分割が必要になったときの判断基準」):

| Criterion | Meaning |
|---|---|
| Table ownership | The domain's tables have a single owner; no other domain reads or writes its D1 directly. |
| One shared contract | The cross-boundary contract lives in exactly one place (`shared/` in this repo, or a versioned, vendored package such as `@flaxia/mail-contract`), so there is no cross-repo type drift. |
| Deploy order + secret ownership | The deployment order is written down (for example mail before Pages), and each secret has exactly one owner. |

Applying the criteria is what produced the approved mail split: `flaxia-mail`
owns the mailbox tables, `@flaxia/mail-contract` owns the address/HMAC/ECIES
contract, and Flaxia keeps only `functions/api/routes/mail.ts`, `src/lib/mail/*`,
and the `MAIL_SERVICE` binding.

## Current blockers

- **Shared main D1.** D1 `flaxia` is still opened directly by the Pages app,
  `flaxia-ap-delivery` (`functions/queue-worker.ts`), and `flaxia-sandbox`
  (`src/sandbox-worker.ts`). Any service that keeps a direct handle on the main
  database is not a clean split yet.
- **Ports ratchet.** Only `functions/lib/adapters/cloudflare` implements the
  ports, and `createCloudflareServices` is currently used by
  `functions/api/routes/media.ts` alone. Media upload
  (`functions/lib/media-upload.ts`) is fully port-based, but the remaining
  baseline is **92 files / 147 violations** in
  `tests/architecture-baseline.json`. Until the Db port covers more routes, a
  split would copy Cloudflare-specific data access across repositories.
