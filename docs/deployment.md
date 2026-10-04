# Deployment

## Admin bootstrap (#134)

Admin rights live on `users.role`, not on usernames. After migrating, assign the first admin directly in D1:

```bash
npm run migrate:prod
wrangler d1 execute flaxia --remote --command "UPDATE users SET role='admin' WHERE username='<name>'"
```

`ADMIN_USERNAMES` in `wrangler.toml` stays empty in the repo; it is only a bootstrap fallback (local `dev:*` scripts set a test value). Never commit a real username there.

## Overview

Flaxia consists of 3 deployable components:

| Component | Config | Deployment Command |
|---|---|---|
| Main Pages (SPA + API) | `wrangler.toml` | `pnpm deploy` |
| Backend Worker (Queue consumer) | `wrangler.toml.worker` | Manual `wrangler deploy` |
| Sandbox Worker | `wrangler.sandbox.toml` | `pnpm deploy:sandbox` |
| Status Worker (`status.flaxia.app`) | `status-worker/wrangler.toml.example`（設定は未作成） | 現在デプロイ不可（下記参照） |

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
ステータスサイトでしたが、コミット `0f0eadf`（"Remove status-worker and flaxia-status deployment"）で
ワーカー一式（`wrangler.toml` / `src/index.ts` / `public/` / `migrations/`）が削除されました。
現在リポジトリに残るのはテスト用の純粋関数 `status-worker/src/transition.ts` のみで、
`status.flaxia.app` はデプロイされていません。

削除に合わせて `package.json` の `deploy:status` / `dev:status` / `migrate:status` /
`migrate:status:local` も削除済みです（存在しない `status-worker/wrangler.toml` を参照して
必ず失敗するため）。再開する場合の設定雛形として
`status-worker/wrangler.toml.example`（削除前の name / compatibility_date / bindings を復元）を置いてあります。

**再構築手順:**

```bash
# 1. 雛形をコピー
cp status-worker/wrangler.toml.example status-worker/wrangler.toml

# 2. D1 データベースを作成し、database_id を status-worker/wrangler.toml に記述
npx wrangler d1 create flaxia-status

# 3. ワーカー実装・public/・migrations/ を復元（0f0eadf^ から取得できる。
#    transition.ts は現在の実装に置き換わっているため引数の整合が必要）
git show 0f0eadf^:status-worker/src/index.ts

# 4. シークレットを設定（認証シナリオと Crowd 検証に必要）
npx wrangler secret put CROWD_API_KEY        --config status-worker/wrangler.toml
npx wrangler secret put STATUS_TEST_EMAIL    --config status-worker/wrangler.toml
npx wrangler secret put STATUS_TEST_PASSWORD --config status-worker/wrangler.toml

# 5. マイグレーションを適用してデプロイ
npm run migrate:status:local   # ローカル
npm run migrate:status         # 本番
npm run deploy:status
```

削除前の構成では、チェック間隔は `[triggers] crons`（毎分。認証は 2 分おき、Crowd 実タスクは 5 分おき）、
公開 API は `/api/status`（最新状態）と `/api/history?check=&days=`（稼働率グラフ用）でした。
ログイン検証用テストアカウント（`STATUS_TEST_USERNAME` と一致させる）は本番 DB に永続化されるため、
強固なパスワードを使い、誤ってコミットしないこと。

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
