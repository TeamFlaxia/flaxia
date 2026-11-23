# Development Setup

## Prerequisites

- Node.js >= 18
- npm >= 10
- Wrangler CLI (included via `wrangler` dev dependency)

## Quick Start

```bash
# Install dependencies
npm install

# Run local migrations (creates local D1 database)
npm run migrate:local

# Start Flaxia + local Auth (expects ../flaxia-auth; use npm run dev:guest without it)
npm run dev
```

Flaxia runs at `http://localhost:8787`; local Auth runs at `http://localhost:8799`.

## Package Manager

Scripts run with **npm** (see AGENTS.md); the `packageManager` field is legacy.

```bash
# Add a dependency
npm install <package>

# Add a dev dependency
npm install -D <package>
```

Do NOT use `yarn add`.

## Dev Server Modes

Auth lives in `TeamFlaxia/flaxia-auth`; `npm run dev` starts it alongside the
app so local login works.

```bash
# Flaxia + local Auth (default). Expects ../flaxia-auth, or FLAXIA_AUTH_DIR.
npm run dev

# Same, with a Vite build watcher
npm run dev:hot

# UI-only: no Auth, login disabled (use when you do not need a session)
npm run dev:guest

# API-only dev (skip the Vite rebuild, use existing dist/)
npm run dev:api
```

`scripts/dev.mjs` applies both local D1 migrations, builds the Auth login UI,
starts Auth on `:8799` and Flaxia on `:8787`, and wires the `AUTH_SERVICE`
binding plus `AUTH_UI_ORIGIN`. If an Auth worker is already healthy on the
configured port it is reused. Override the defaults with:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FLAXIA_AUTH_DIR` | `../flaxia-auth` | Auth repository path |
| `FLAXIA_DEV_PORT` | `8787` | Flaxia dev server port |
| `FLAXIA_AUTH_PORT` | `8799` | Auth worker port |
| `FLAXIA_AUTH_INSPECTOR_PORT` | `authPort + 100` | Auth inspector port |

## Environment Variables

Copy `.env.example` to a `.env` file (if needed for custom values). Key variables:
- `CLOUDFLARE_ACCOUNT_ID` — Your Cloudflare account ID

Additional vars are defined in `vite.config.ts`:
- `VITE_SANDBOX_ORIGIN` — Sandbox origin URL
- `VITE_CONTENT_ORIGIN` — Content origin URL

## Database Migrations

```bash
# Apply migrations locally
npm run migrate:local

# Apply migrations to production
npm run migrate:prod
```

`migrate:prod` keeps `--remote` on purpose: without it wrangler applies
migrations to the **local** database and production silently stays behind.

Migrations live in `migrations/` as SQL files (e.g., `0001_init.sql`).

## Testing

Tests use Node.js native test runner with experimental TypeScript stripping.

```bash
# Run all tests
npm test

# Run individual test suites
npm test:auth
npm test:posts
npm test:users
npm test:notifications
npm test:tags
```

## Local Test Accounts

See `local-test-accounts.md` for how to create a local test account (no shared passwords).

## Configuration Files

| File | Purpose |
|---|---|
| `wrangler.toml` | Main Pages project config (D1, R2, KV, Queue bindings) |
| `wrangler.worker.toml` | Queue Worker config (`flaxia-ap-delivery`, `functions/queue-worker.ts`) |
| `wrangler.sandbox.toml` | Sandbox Worker config |
| `vite.config.ts` | Vite build configuration |
| `tsconfig.json` | TypeScript strict mode config |
