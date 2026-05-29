# Development Setup

## Prerequisites

- Node.js >= 18
- pnpm >= 8.0.0
- Wrangler CLI (included via `wrangler` dev dependency)

## Quick Start

```bash
# Install dependencies
pnpm install

# Run local migrations (creates local D1 database)
pnpm migrate:local

# Start dev server (build + wrangler pages dev)
pnpm dev
```

The dev server starts at `http://localhost:8787`.

## Package Manager

This project uses **pnpm** (`packageManager: "pnpm@8.0.0"` in package.json).

```bash
# Add a dependency
pnpm add <package>

# Add a dev dependency
pnpm add -D <package>
```

Do NOT use `npm install` or `yarn add`.

## Dev Server Modes

```bash
# Full build + dev server (default)
pnpm dev

# Hot reload (watch mode for Vite build)
pnpm dev:hot

# API-only dev (skip Vite rebuild, use existing dist/)
pnpm dev:api
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
pnpm migrate:local

# Apply migrations to production
pnpm migrate:prod
```

Migrations live in `migrations/` as SQL files (e.g., `0001_init.sql`).

## Testing

Tests use Node.js native test runner with experimental TypeScript stripping.

```bash
# Run all tests
pnpm test

# Run individual test suites
pnpm test:auth
pnpm test:posts
pnpm test:users
pnpm test:notifications
pnpm test:tags
pnpm test:rate-limit
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
