# Flaxia

[![CI](https://github.com/RemydreScarlet/flaxia/actions/workflows/ci.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/ci.yml)
[![Deploy](https://github.com/RemydreScarlet/flaxia/actions/workflows/deploy.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/deploy.yml)
[![Release](https://github.com/RemydreScarlet/flaxia/actions/workflows/release.yml/badge.svg)](https://github.com/RemydreScarlet/flaxia/actions/workflows/release.yml)

SNS where posts are living, interactive applications.

ZIP (HTML5 ゲーム), SWF (Flash), 画像, 音声を投稿に添付でき、サンドボックス環境で安全に実行できます。

## 開発者向けドキュメント

ゲーム作者・連携アプリ開発者向けのドキュメントは [docs/developer/](docs/developer/) にまとめています。

- [Flaxia Game API](docs/developer/game-api.md) — サンドボックスゲームの契約
- [Flaxia Game SDK](docs/developer/sdk.md) — `@flaxia/game-sdk`
- [REST API](docs/developer/rest-api.md) — 全エンドポイント
- [ゲームの公開](docs/developer/publishing.md) — ZIP 仕様と公開フロー

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