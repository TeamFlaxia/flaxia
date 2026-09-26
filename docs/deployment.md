# Deployment

## Overview

Flaxia consists of 3 deployable components:

| Component | Config | Deployment Command |
|---|---|---|
| Main Pages (SPA + API) | `wrangler.toml` | `pnpm deploy` |
| Backend Worker (Queue consumer) | `wrangler.toml.worker` | Manual `wrangler deploy` |
| Sandbox Worker | `wrangler.sandbox.toml` | `pnpm deploy:sandbox` |
| Status Worker (`status.flaxia.app`) | `status-worker/wrangler.toml` | `pnpm deploy:status` |

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

## Status Worker (`status.flaxia.app`)

`status.flaxia.app` は Flaxia の各コンポーネント（Web / API / 認証 / Crowd）を定期チェックする
ステータスサイトです。独自の D1 データベース・Cron トリガー・静的アセットを持ちます。

**初回セットアップ（手動で 1 回だけ）:**

```bash
# 1. D1 データベースを作成し、database_id を status-worker/wrangler.toml に記述
npx wrangler d1 create flaxia-status

# 2. マイグレーションを適用
pnpm migrate:status:local   # ローカル
pnpm migrate:status         # 本番

# 3. シークレットを設定（認証シナリオと Crowd 検証に必要）
npx wrangler secret put CROWD_API_KEY        --config status-worker/wrangler.toml
npx wrangler secret put STATUS_TEST_EMAIL    --config status-worker/wrangler.toml
npx wrangler secret put STATUS_TEST_PASSWORD --config status-worker/wrangler.toml

# 4. ログイン検証用のテストアカウントを本番に作成（1 回だけ）
curl -X POST https://flaxia.app/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@flaxia.app","password":"<強固なパスワード>","username":"devstatus","display_name":"Status Monitor"}'
# STATUS_TEST_USERNAME (wrangler.toml) と username を一致させること

# 5. デプロイ（routes により status.flaxia.app が自動で付与される）
pnpm deploy:status
```

**ローカル開発:**

```bash
# シークレットは status-worker/.dev.vars に記載（.dev.vars.example 参照）
pnpm dev:status                    # 起動後 http://localhost:8791
curl -X POST "http://localhost:8791/__scheduled?cron=* * * * *"  # 手動トリガー
```

- チェック間隔: `wrangler.toml` の `[triggers] crons`（毎分）。認証は 2 分おき、Crowd 実タスクは 5 分おきに絞られています。
- 公開 API: `/api/status`（最新状態）、`/api/history?check=&days=`（稼働率グラフ用）。
- テストアカウントは本番 DB に永続化されるため、強固なパスワードを使い、誤ってコミットしないこと。

## Post-Deployment Steps

1. **Database Migrations** (production):
   ```bash
   npm run migrate:prod
   ```

   本番適用後は pending が 0 であることを必ず確認する:
   ```bash
   npx wrangler d1 migrations list flaxia --remote   # "No migrations to apply!" が出れば OK
   ```

   pending を残したままデプロイすると、サーバーが前提とするスキーマと本番 DB が
   食い違う。例えば添付の `kind` に `'document'` を追加するマイグレーション
   (`0096`) が未適用のまま `POST /api/posts/commit` が `document` を書き込もうと
   すると `CHECK constraint failed: kind` で 500 になる。テストはローカル DB に
   マイグレーションを適用した状態で走るため、この種のずれは CI では検出できない。

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
