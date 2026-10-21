# Flaxia

[![CI](https://github.com/RemydreScarlet/flaxia/actions/workflows/ci.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/ci.yml)
[![Deploy](https://github.com/RemydreScarlet/flaxia/actions/workflows/deploy.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/deploy.yml)
[![Release](https://github.com/RemydreScarlet/flaxia/actions/workflows/release.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/release.yml)

SNS where posts are living, interactive applications.

ZIP (HTML5 ゲーム), SWF (Flash), 画像, 音声を投稿に添付でき、サンドボックス環境で安全に実行できます。

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

Before_implementing.md を実装前に読むことをおすすめします。