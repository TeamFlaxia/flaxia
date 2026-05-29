# Deployment

## Overview

Flaxia consists of 3 deployable components:

| Component | Config | Deployment Command |
|---|---|---|
| Main Pages (SPA + API) | `wrangler.toml` | `pnpm deploy` |
| Backend Worker (Queue consumer) | `wrangler.toml.worker` | Manual `wrangler deploy` |
| Sandbox Worker | `wrangler.sandbox.toml` | `pnpm deploy:sandbox` |

## Main Pages Deployment

```bash
# Build and deploy to Cloudflare Pages
pnpm build && pnpm deploy

# This runs:
# CONTENT_ORIGIN=https://sandbox.flaxia.app wrangler pages deploy dist
```

The build output is in `dist/`.

## Backend Worker (flaxia-backend)

This worker hosts Durable Objects and consumes the ActivityPub delivery queue.

```bash
npx wrangler deploy functions/queue-worker.ts \
  --config wrangler.toml.worker \
  --name flaxia-ap-delivery \
  --compatibility-date 2024-01-01
```

The main Pages project binds to this worker via `wrangler.toml`:
```toml
[[services]]
binding = "BACKEND"
service = "flaxia-backend"
```

## Sandbox Worker

```bash
pnpm deploy:sandbox

# This runs:
# wrangler deploy src/sandbox-worker.ts --config wrangler.sandbox.toml
```

The sandbox worker serves ZIP/HTML5 content from R2 at the sandbox origin (`sandbox.flaxia.app`).

## Post-Deployment Steps

1. **Database Migrations** (production):
   ```bash
   pnpm migrate:prod
   ```

2. **Verify**:
   - Main site: `https://flaxia.app`
   - Sandbox: `https://sandbox.flaxia.app`

## Monitoring

```bash
# Tail production logs
wrangler pages deployment tail

# Tail worker logs
wrangler tail --config wrangler.toml.worker
```

## Important Notes

- Both `flaxia-backend` and `flaxia` (Pages) must be deployed together for ActivityPub to work
- The sandbox origin is a separate Worker with its own routes
- `wrangler.toml` references the backend Worker by script name — ensure the backend Worker is deployed first
- Environment-specific config is handled via Wrangler secrets/vars, not `.env` files in production
