# Flaxia

[![CI](https://github.com/RemydreScarlet/flaxia/actions/workflows/ci.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/ci.yml)
[![Deploy](https://github.com/RemydreScarlet/flaxia/actions/workflows/deploy.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/deploy.yml)
[![Release](https://github.com/RemydreScarlet/flaxia/actions/workflows/release.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/release.yml)

Chronological SNS where posts are living, interactive applications.

## Development


### Deployment
```bash
npm run build && npm run deploy
```

### Debuging
```bash
wrangler pages deployment tail
```

### Worker Deployment
```bash
npx wrangler deploy functions/queue-worker.ts --config wrangler.toml.worker --name flaxia-ap-delivery --compatibility-date 2024-01-01
```

## Architecture

- **Runtime**: Cloudflare Pages + Workers
- **API**: Hono framework
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2
