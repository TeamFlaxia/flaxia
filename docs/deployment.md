# Deployment

## Admin bootstrap (#134)

Admin rights live on `users.role`, not on usernames. After migrating, assign the first admin directly in D1:

```bash
npm run migrate:prod
wrangler d1 execute flaxia --remote --command "UPDATE users SET role='admin' WHERE username='<name>'"
```

`ADMIN_USERNAMES` in `wrangler.toml` stays empty in the repo; it is only a bootstrap fallback (local `dev:*` scripts set a test value). Never commit a real username there.

## Overview

Flaxia consists of 4+ deployable components:

| Component | Config | Deployment Command |
|---|---|---|
| Main Pages (SPA + API) | `wrangler.toml` | `pnpm deploy` |
| Backend Worker (Queue consumer) | `wrangler.toml.worker` | Manual `wrangler deploy` |
| Sandbox Worker | `wrangler.sandbox.toml` | `pnpm deploy:sandbox` |
| Mail Worker (`flaxia-mail`) | `mail-worker/wrangler.toml` | `npm run deploy:mail`（D1 migrate 後にデプロイ。`workers.dev` 公開なし） |
| Status Worker (`status.flaxia.app`) | `status-worker/wrangler.toml.example`（設定は未作成） | 現在デプロイ不可（下記参照） |

## Flaxia Mail (`docs/mail.md`)

Mail は apex `flaxia.app` の `@flaxia.app` メールボックス。既存の human Email Routing 転送は削除され、ユーザーメールは Mail Worker（`flaxia-mail`）へ向き、未知の宛先は 550 で拒否される（D6）。`postmaster@flaxia.app` と `abuse@flaxia.app` の2件だけは Email Routing で `teamflaxia@proton.me` へ転送される例外（`docs/mail.md` §11.1.3）。

```bash
# 1. Mail の D1 / R2 / Queue を作成
npx wrangler d1 create flaxia-mail
#    -> 出力された database_id を GitHub repository secret
#       MAIL_D1_DATABASE_ID に登録する。deploy.yml が CI 実行時に
#       mail-worker/wrangler.toml のプレースホルダを置き換える。
#       ローカルで migrate/deploy する場合だけ、wrangler.toml の
#       database_id を一時的に同じ値へ書き換える。
npx wrangler r2 bucket create flaxia-mail-content
npx wrangler queues create flaxia-mail-queue
npx wrangler queues create flaxia-mail-dlq
# 本番 migrate は deploy.yml の deploy-mail が実行する。
# ローカルから実行する場合: npm run migrate:mail:prod

# 2. Worker をデプロイ（Email Routing ハンドラ + 内部 API）
npm run deploy:mail

# 3. Pages 側の binding が有効になるよう Pages をデプロイする。
#    P1 では Email Routing / MX をまだ切り替えない。Worker は
#    MAIL_INBOUND_ENABLED=0 で受信を拒否し、P2 (MIME auth/scan/threading/UI)
#    完了後に "1" へ変更して cutover する。
#    MAIL_INTERNAL_SECRET / MAIL_THREAD_SECRET は secret として設定:
npx wrangler secret put MAIL_INTERNAL_SECRET --config mail-worker/wrangler.toml
npx wrangler secret put MAIL_THREAD_SECRET --config mail-worker/wrangler.toml
npx wrangler pages secret put MAIL_INTERNAL_SECRET --project-name flaxia
# 予約されたアカウント削除（scheduled backend worker）も Mail を消すため、
# 同じ secret を backend worker にも設定する。
npx wrangler secret put MAIL_INTERNAL_SECRET --config wrangler.toml.worker
```

DNS/MX/SPF/DKIM/DMARC の手順は `docs/mail.md` §11.1 を参照。メール関連レコードは DNS-only（proxy しない）。P1 デプロイでは Email Routing に一切触れない。

### postmaster/abuse 転送（Cloudflare ダッシュボード作業）

コード変更は不要。Cloudflare Email Routing で以下を設定します：

1. **宛先（Destination）を登録・検証** — `teamflaxia@proton.me` を Destination Address として追加。Cloudflare から届く確認メールを proton.me 側で承認する。未検証の宛先への転送ルールは作成できない。
2. **ルーティングルール（Custom address）** — `postmaster@flaxia.app` → `teamflaxia@proton.me`、`abuse@flaxia.app` → `teamflaxia@proton.me` の2件を作成。どちらのルールも「Catch-all」の上位に置く。**P1 デプロイでは catch-all を変更しない**（P2 の cutover 時に Mail Worker へ向ける）。
3. **検証** — 外部アドレスから `postmaster@flaxia.app` / `abuse@flaxia.app` 宛にテスト送信し、proton.me 側に届くことを確認する。届かなければ Email Routing の「Domain status」が `Active` になっているか、宛先が `Verified` かを確認する。
4. **注意** — この2アドレスのメールは Flaxia Mail の暗号化境界の外（proton.me 上で平文として格納される）。プライバシーポリシー等では「Flaxia Mail の暗号化はこの2アドレスには適用されない」と案内すること。

## Main Pages Deployment

```bash
# Build and deploy to Cloudflare Pages
pnpm build && pnpm deploy

# This runs:
# CONTENT_ORIGIN=https://sandbox.flaxia.app wrangler pages deploy dist
```

The build output is in `dist/`.

## Crowd integration secrets

The Crowd worker signs every webhook delivery with its dedicated
`WEBHOOK_SIGNING_SECRET` (`X-Flaxia-Signature` / `X-Flaxia-Timestamp` /
`X-Flaxia-Nonce`). Set the same value on the Pages project so callbacks verify:

```bash
npx wrangler pages secret put CROWD_API_KEY --project-name flaxia
npx wrangler pages secret put CROWD_WEBHOOK_SIGNING_SECRET --project-name flaxia
```

The legacy `?sig=` query contract is retired: without
`CROWD_WEBHOOK_SIGNING_SECRET`, every callback is rejected `401` (unsigned
callbacks are accepted only by an unconfigured localhost dev/test server).
`CROWD_WEBHOOK_SECRET` now only keys the short-lived scan-file tickets and
defaults to `CROWD_API_KEY`. The `crowd_webhook_nonces` table from migration
`0129_crowd_webhook_nonces.sql` stores the replay guard; apply migrations
before deploying.

## GitHub bug reports (#263)

Apply D1 migrations before deploying this feature; migration `0128_bug_report_submissions.sql` provides submission reservations and rate limits. The table stores only reservation metadata (a content fingerprint, issue URL, and expiry), never report text, diagnostics, or screenshots; the scheduled backend worker removes expired rows daily.

The Settings → Other → Report a bug form creates public issues in
`TeamFlaxia/flaxia`. Configure a GitHub App installed on that repository with
**Issues: read and write** permission. Keep the App ID, installation ID, and
private key in Pages Secrets; local development can use `.dev.vars`:

```bash
npx wrangler pages secret put GITHUB_APP_ID --project-name flaxia
npx wrangler pages secret put GITHUB_APP_INSTALLATION_ID --project-name flaxia
npx wrangler pages secret put GITHUB_APP_PRIVATE_KEY --project-name flaxia
```

The private key may be the PEM downloaded from GitHub. The installation token
is created server-side for each submission and is never sent to the browser.
If credentials are missing, the form reports that submission is unavailable.
Redeploy the backend worker (below) to enable its daily cleanup of expired
reservation rows.

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

# 5. worker・migrations・設定を復元した後にマイグレーションを適用してデプロイ
npx wrangler d1 migrations apply flaxia-status --local --config status-worker/wrangler.toml
npx wrangler d1 migrations apply flaxia-status --remote --config status-worker/wrangler.toml
npx wrangler deploy --config status-worker/wrangler.toml
```

削除前の構成では、チェック間隔は `[triggers] crons`（毎分。認証は 2 分おき、Crowd 実タスクは 5 分おき）、
公開 API は `/api/status`（最新状態）と `/api/history?check=&days=`（稼働率グラフ用）でした。
ログイン検証用テストアカウント（`STATUS_TEST_USERNAME` と一致させる）は本番 DB に永続化されるため、
強固なパスワードを使い、誤ってコミットしないこと。

## Post-Deployment Steps

1. **Database Migrations** (production):
   The GitHub Actions deployment applies pending D1 migrations before deploying
   Pages. If that step fails, fix the reported migration issue and rerun the
   deployment; do not leave migrations pending.

   For manual recovery when needed:
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

## ActivityPub delivery dead-letter queue (#141)

The deployment workflow ensures the dead-letter queue exists in the same
Cloudflare account before deploying `flaxia-backend`. For manual deployment,
create it once before deploying with `wrangler.toml.worker`:

```bash
npx wrangler queues create activitypub-delivery-dlq
npx wrangler deploy --config wrangler.toml.worker
```

The `activitypub-delivery` consumer retries a failed delivery **at most three
times** and then moves the message to `activitypub-delivery-dlq` rather than
dropping it silently. The DLQ has **no automatic consumer**: inspect it via
Cloudflare Queues metrics / dashboard, set up alerts for non-zero DLQ depth,
and review quarantined messages before redelivery. Do not replay messages
indiscriminately if the original failure was caused by a data constraint;
fix the root cause first.

If deployment reports that the DLQ does not exist, do **not** remove the
`dead_letter_queue` setting. Create the queue and redeploy.
