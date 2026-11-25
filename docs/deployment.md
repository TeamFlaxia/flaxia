# Deployment

## Admin bootstrap (#134)

Admin rights live on `users.role`, not on usernames. After migrating, assign the first admin directly in D1:

```bash
npm run migrate:prod
wrangler d1 execute flaxia --remote --command "UPDATE users SET role='admin' WHERE username='<name>'"
```

`ADMIN_USERNAMES` in `wrangler.toml` stays empty in the repo; it is only a bootstrap fallback (local `dev:*` scripts set a test value). Never commit a real username there.

## Overview

Flaxia consists of several independently deployed components. The auth and mail
Workers live in their own repositories; the rest are deploy units inside this
repo:

| Component | Config | Deployment Command |
|---|---|---|
| Main Pages (SvelteKit SSR + API) | `wrangler.toml` | `npm run deploy` |
| Auth Worker (`flaxia-auth`, separate repo) | `../flaxia-auth/wrangler.jsonc` | run from the `TeamFlaxia/flaxia-auth` repo |
| Mail Worker (`flaxia-mail`, separate repo; no `workers.dev` route) | `../flaxia-mail/worker/wrangler.toml` | deploy from the `TeamFlaxia/flaxia-mail` repo |
| Queue Worker (ActivityPub delivery, `flaxia-ap-delivery`) | `wrangler.worker.toml`, `functions/queue-worker.ts` | GitHub Actions `deploy-queue` |
| Sandbox Worker (`flaxia-sandbox`) | `wrangler.sandbox.toml` | `npm run deploy:sandbox` |
| DO Worker (`notif-stream`) | `do-worker/wrangler.toml` | `npm run deploy:do` |
| Multiplayer Worker (`multiplayer-worker`) | `multiplayer-worker/wrangler.toml` | `npm run deploy:multiplayer` |
| Status Worker (`status.flaxia.app`) | `status-worker/wrangler.toml.example`（設定は未作成） | 現在デプロイ不可（下記参照） |

Repo / データ所有 / secret / デプロイ順の全体像は
`docs/architecture/service-map.md` を参照。

## Package distribution

**No Flaxia package is published to the npm registry.** Packages stay public (no
`private` flag) so anyone can read them, but a `prepublishOnly` script refuses to
publish. Distribution is two things only:

1. A committed tarball inside the consumer (`vendor/*.tgz`, referenced as a
   `file:` dependency in `package.json`).
2. A GitHub Release asset (the same tarball) on the producer's repo.

| Package | Consumer reference | Release asset |
|---|---|---|
| `@flaxia/node` 0.10.0 | `flaxia/vendor/flaxia-node-0.10.0.tgz` | `https://github.com/TeamFlaxia/flaxia-crowd/releases/download/node-v0.10.0/flaxia-node-0.10.0.tgz` |
| `@flaxia/sdk` 0.8.0 | `flaxia/vendor/flaxia-sdk-0.8.0.tgz` | `https://github.com/TeamFlaxia/flaxia-crowd/releases/download/sdk-v0.8.0/flaxia-sdk-0.8.0.tgz` |
| `@flaxia/mail-contract` 0.1.1 | `flaxia/vendor/flaxia-mail-contract-0.1.1.tgz` | `https://github.com/TeamFlaxia/flaxia-mail/releases/download/contract-v0.1.1/flaxia-mail-contract-0.1.1.tgz` |

Upgrading a package means bumping the tarball in `vendor/`, updating the `file:`
path, and re-running the install; there is no semver range to resolve. For
`@flaxia/node`, also bump `CROWD_NODE_VERSION` in `shared/crowd-node.ts` and the
entry-path test, then re-run `npm run build` so `/crowd/v<version>-0/` and the
generated CSP hashes are refreshed (see `docs/web-index.md`).

The **Game SDK is not distributed at all**: it is served from the sandbox origin
as `/sdk/game.js` (IIFE, global `FlaxiaGame`) and is part of the sandbox deploy.

### Crowd browser assets

The Crowd node bundle the browser loads is copied from
`node_modules/@flaxia/node/dist` into the Pages build output at
`/crowd/v0.10.0-0/`. It is therefore **same-origin** (`flaxia.app`), versioned by
path, and served with an immutable cache header; it ships with the ordinary Pages
deploy. There is no unpkg asset proxy — only `/api/crowd/webhook` and
`/api/crowd/scan-file` remain as Crowd routes. CSP still allows `unpkg.com` for
Ruffle (the third-party Flash player) and nothing of ours.

## Flaxia Mail (`docs/mail.md`)

**Mail は独立デプロイ。** Worker・D1・R2・queue は `TeamFlaxia/flaxia-mail` リポジトリが
所有し、共有契約は `@flaxia/mail-contract`（mail address / WebCrypto・HMAC / ECIES）。
Flaxia 側ではこの契約を npm からではなく `vendor/flaxia-mail-contract-0.1.1.tgz`
（`file:` 依存）として参照する。Flaxia 側に残るのは `functions/api/routes/mail.ts` の proxy、
`src/lib/mail/*` と `src/routes/mail/*` の UI、`MAIL_SERVICE` binding、および
`MAIL_INTERNAL_SECRET` の設定だけ。`MAIL_THREAD_SECRET` は Worker 側で管理する。
`mail-worker/` と `npm run deploy:mail` は分割完了に伴いこのリポジトリから削除済み。

デプロイ順は **mail → pages**。Pages は `MAIL_SERVICE` を service 名で解決するため、
Flaxia の mail API 側に変更が入るときは先に `flaxia-mail` をデプロイする
（`.github/workflows/deploy.yml` の `deploy-queue` も mail internal API の変更前に
mail をデプロイするようコメントしている）。

Mail は apex `flaxia.app` の `@flaxia.app` メールボックス。既存の human Email Routing 転送は削除され、ユーザーメールは Mail Worker（`flaxia-mail`）へ向き、未知の宛先は 550 で拒否される（D6）。`postmaster@flaxia.app` と `abuse@flaxia.app` の2件だけは Email Routing で `teamflaxia@proton.me` へ転送される例外（`docs/mail.md` §11.1.3）。

```bash
# flaxia-mail リポジトリ（worker/ が Worker の root。deploy は CI と同じ手順）
npx wrangler d1 create flaxia-mail                   # 初回のみ
npx wrangler r2 bucket create flaxia-mail-content    # 初回のみ
npx wrangler queues create flaxia-mail-queue         # 初回のみ
npx wrangler queues create flaxia-mail-dlq           # 初回のみ

cd worker
npx wrangler d1 migrations apply flaxia-mail --remote  # deploy より先に適用
npx wrangler deploy
npx wrangler secret put MAIL_INTERNAL_SECRET
npx wrangler secret put MAIL_THREAD_SECRET
```

```bash
# Flaxia リポジトリ（Pages と scheduled queue worker）
npx wrangler pages secret put MAIL_INTERNAL_SECRET --project-name flaxia
npx wrangler secret put MAIL_INTERNAL_SECRET --config wrangler.worker.toml
```

`database_id` は `flaxia-mail` リポジトリの `worker/wrangler.toml` にコミット済み。
DB を作り直した場合だけ、その値を更新してコミットする。P2 (MIME parse / 暗号化保存 /
threading / 一覧・スレッド UI) は実装済みで、2026-11-07 の apex cutover 以降
`MAIL_INBOUND_ENABLED=1` で受信している。受信を止めたい障害時だけ `"0"` にして再デプロイする。

DNS/MX/SPF/DKIM/DMARC の手順は `docs/mail.md` §11.1 を参照。メール関連レコードは DNS-only（proxy しない）。apex cutover は 2026-11-07 に実行済みで、catch-all は Mail Worker に向いている。再構築・障害時の手順は `docs/mail.md` §11.1 を正とする。

### postmaster/abuse 転送（Cloudflare ダッシュボード作業）

コード変更は不要。Cloudflare Email Routing で以下を設定します：

1. **宛先（Destination）を登録・検証** — `teamflaxia@proton.me` を Destination Address として追加。Cloudflare から届く確認メールを proton.me 側で承認する。未検証の宛先への転送ルールは作成できない。
2. **ルーティングルール（Custom address）** — `postmaster@flaxia.app` → `teamflaxia@proton.me`、`abuse@flaxia.app` → `teamflaxia@proton.me` の2件を作成。どちらのルールも catch-all（Mail Worker 行き）の上位に置く。
3. **検証** — 外部アドレスから `postmaster@flaxia.app` / `abuse@flaxia.app` 宛にテスト送信し、proton.me 側に届くことを確認する。届かなければ Email Routing の「Domain status」が `Active` になっているか、宛先が `Verified` かを確認する。
4. **注意** — この2アドレスのメールは Flaxia Mail の暗号化境界の外（proton.me 上で平文として格納される）。プライバシーポリシー等では「Flaxia Mail の暗号化はこの2アドレスには適用されない」と案内すること。

## Main Pages Deployment

`npm run build` uses `@sveltejs/adapter-cloudflare`: it writes `_worker.js` and
the static assets to `.svelte-kit/cloudflare`, which is also
`pages_build_output_dir` in `wrangler.toml`. `npm run build:native` is a
different build (static SPA into `dist/`) for Capacitor and Tauri only — never
deploy that directory to Pages.

```bash
# vite.config.ts bakes both origins into the bundle at BUILD time. The deploy
# workflow sets SANDBOX_ORIGIN only; production builds therefore leave
# CONTENT_ORIGIN empty. Set CONTENT_ORIGIN on the build command explicitly if a
# build needs it — changing it at deploy time cannot affect a built bundle.
SANDBOX_ORIGIN=https://sandbox.flaxia.app npm run build
npm run deploy

# `npm run deploy` runs:
#   wrangler pages deploy .svelte-kit/cloudflare
```

The Pages build output is in `.svelte-kit/cloudflare/`.

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

Apply D1 migrations before deploying this feature; migration `0128_bug_report_submissions.sql` provides submission reservations and rate limits. The table stores only reservation metadata (a content fingerprint, issue URL, and expiry), never report text, diagnostics, or screenshots; the scheduled queue worker (`flaxia-ap-delivery`) removes expired rows daily.

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
Redeploy the queue worker (`flaxia-ap-delivery`, below) to enable its daily
cleanup of expired
reservation rows.

## Queue Worker (`flaxia-ap-delivery`)

This worker consumes the ActivityPub delivery queue. GitHub Actions deploys it
as `flaxia-ap-delivery` in the `deploy-queue` job; deploying it under another
name leaves the queue bound to a stale worker and posts silently stop
federating.

```bash
npx wrangler deploy functions/queue-worker.ts \
  --config wrangler.worker.toml \
  --name flaxia-ap-delivery \
  --compatibility-date 2024-01-01
```

`wrangler.worker.toml` sets the same name, so a plain
`npx wrangler deploy --config wrangler.worker.toml` targets the consumer too.

## Sandbox Worker

```bash
npm run deploy:sandbox

# This runs:
# npm run build:game-loader && wrangler deploy src/sandbox-worker.ts --config wrangler.sandbox.toml
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
wrangler tail --config wrangler.worker.toml
```

## Important Notes

- Both `flaxia-ap-delivery` (queue worker) and `flaxia` (Pages) must be deployed together for ActivityPub to work
- The sandbox origin is a separate Worker (`flaxia-sandbox`) with its own routes
- `wrangler.toml` binds `notif-stream` and `multiplayer-worker` by script name, and `AUTH_SERVICE` / `MAIL_SERVICE` by service name — deploy those services first
- Mail deploys before Pages (Pages only needs `MAIL_SERVICE` plus the HMAC secrets)
- Environment-specific config is handled via Wrangler secrets/vars, not `.env` files in production

## ActivityPub delivery dead-letter queue (#141)

The deployment workflow ensures the dead-letter queue exists in the same
Cloudflare account before deploying `flaxia-ap-delivery`. For manual deployment,
create it once before deploying with `wrangler.worker.toml`:

```bash
npx wrangler queues create activitypub-delivery-dlq
npx wrangler deploy --config wrangler.worker.toml
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
