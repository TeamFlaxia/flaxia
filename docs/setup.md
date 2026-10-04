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

# Start dev server (build + wrangler pages dev)
npm run dev
```

The dev server starts at `http://localhost:8787`.

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

```bash
# Full build + dev server (default)
npm run dev

# Hot reload (watch mode for Vite build)
npm run dev:hot

# API-only dev (skip Vite rebuild, use existing dist/)
npm run dev:api
```

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

See `local-test-accounts.md` for credentials.

## Configuration Files

| File | Purpose |
|---|---|
| `wrangler.toml` | Main Pages project config (D1, R2, KV, Queue bindings) |
| `wrangler.toml.worker` | Backend Worker config (flaxia-backend) |
| `wrangler.sandbox.toml` | Sandbox Worker config |
| `vite.config.ts` | Vite build configuration |
| `tsconfig.json` | TypeScript strict mode config |
