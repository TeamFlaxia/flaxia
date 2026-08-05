# Deployment

## Overview

Flaxia consists of 5 deployable components:

| Component | Config | Deployment Command |
|---|---|---|
| Main Pages (SPA + API) | `wrangler.toml` | `npm run deploy` |
| Backend Worker (Queue consumer) | `wrangler.toml.worker` | `wrangler deploy --config wrangler.toml.worker --name flaxia-backend` |
| Sandbox Worker | `wrangler.sandbox.toml` | `npm run deploy:sandbox` |
| DO Worker (NotificationStream) | `do-worker/wrangler.toml` | `npm run deploy:do` |
| Multiplayer Worker (MultiplayerRoom/Matchmaker) | `multiplayer-worker/wrangler.toml` | `npm run deploy:multiplayer` |

All workers use a unified `compatibility_date = "2026-06-02"` with the `nodejs_compat` flag.

## Main Pages Deployment

```bash
# Build and deploy to Cloudflare Pages
npm run build && npm run deploy

# This runs:
# CONTENT_ORIGIN=https://sandbox.flaxia.app wrangler pages deploy dist
```

The build output is in `dist/`.

## Backend Worker (flaxia-backend)

This worker consumes the ActivityPub delivery queue.

```bash
npx wrangler deploy functions/queue-worker.ts \
  --config wrangler.toml.worker \
  --name flaxia-backend
```

The main Pages project binds to this worker via `wrangler.toml`:
```toml
[[services]]
binding = "BACKEND"
service = "flaxia-backend"
```

## DO Worker (NotificationStream)

```bash
npm run deploy:do
```

## Multiplayer Worker

```bash
npm run deploy:multiplayer
```

Deploys the `MultiplayerRoom` and `Matchmaker` Durable Objects used for real-time multiplayer rooms and matchmaking.

## Sandbox Worker

```bash
npm run deploy:sandbox

# This runs:
# wrangler deploy src/sandbox-worker.ts --config wrangler.sandbox.toml
```

The sandbox worker serves ZIP/HTML5 content from R2 at the sandbox origin (`sandbox.flaxia.app`).

## Post-Deployment Steps

1. **Database Migrations** (production):
   ```bash
   npm run migrate:prod
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

- The backend, DO, and multiplayer workers must be deployed alongside the Pages project for full functionality
- The sandbox origin is a separate Worker with its own routes
- `wrangler.toml` references the backend Worker by script name — ensure the backend Worker is deployed first
- Environment-specific config is handled via Wrangler secrets/vars, not `.env` files in production
