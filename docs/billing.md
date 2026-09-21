# Billing & Subscriptions

Flaxia uses **Stripe** for subscription billing. Currently only **Flaxia+** is
offered (Flaxia++ / Flaxia# are defined in the database but not sold yet).

---

## Plans

### Plan Flaxia (Free) — 最安値で最高の体験

- SNSとして普通の機能
- 公式提供スタンプ
- ユーザー定義スタンプ（5個まで）
- E2EEなダイナミックメッセージ、グループチャット、サーバーチャット
- 通常品質な通話
- Arcade（Shortsのようなゲームプレイ）

### Plan Flaxia+ (¥150/mo) — そのカフェインをスタンプに ★販売中

- Flaxiaの全ての機能
- ユーザー定義スタンプを無制限に
- ユーザー定義スタンプにgifとmp4を許可
- アイコンにgifとmp4を許可
- 自己紹介にgifとmp4を許可
- 通話品質の改善

### Plan Flaxia++ (¥500/mo) — 未販売（DB定義のみ）

### Plan Flaxia# (¥1,000/mo) — 未販売（DB定義のみ）

---

## Flax-market

FlaxiaのArcade、音楽、動画が対象のマーケットプレイス。**現在は未実装**
（`POST /api/market/checkout` のバックエンドのみ存在）。

---

## API Endpoints

### Subscription

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/billing/checkout` | Flaxia+ の Stripe Checkout セッション作成（`{ planId: "flaxia_plus" }`） |
| `POST` | `/api/billing/portal` | Stripe Customer Portal セッション作成（解約・支払い方法変更） |
| `GET` | `/api/billing/plan` | ユーザーの現在プラン取得 |
| `GET` | `/api/billing/transactions` | 支払い履歴（最新50件） |
| `POST` | `/api/billing/webhook` | Stripe Webhook 受信 |

### Marketplace

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/market/checkout` | マーケット購入用 Checkout（未実装・バックエンドのみ） |

### Checkout

`POST /api/billing/checkout`
- Auth: Required (session cookie)
- Body: `{ planId: "flaxia_plus" }`
- Returns: `{ sessionId, url }` — redirect to Stripe Checkout
- Errors: `400` 未対応プラン / `401` 未認証 / `409` すでに加入済み

### Portal

`POST /api/billing/portal`
- Auth: Required
- Returns: `{ url }` — Stripe Customer Portal（解約・支払い方法変更・領収書）
- Customer Portal は Stripe Dashboard で有効化しておく必要がある

### Get Plan

`GET /api/billing/plan`
- Auth: Optional
- Returns: `{ plan, planName, status, expiresAt, cancelAtPeriodEnd }`

---

## Database Tables

### `subscriptions`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT | PK |
| user_id | TEXT | FK → users(id) |
| stripe_subscription_id | TEXT | UNIQUE |
| stripe_customer_id | TEXT | |
| plan_id | TEXT | `flaxia_plus`, `flaxia_plus_plus`, `flaxia_sharp` |
| status | TEXT | Stripe statuses (`active`, `trialing`, `past_due`, `canceled`, `incomplete`, `incomplete_expired`, `unpaid`, `paused`) |
| cancel_at_period_end | INTEGER | 1 = 期間終了時に解約 |
| current_period_start | TEXT | ISO 8601 |
| current_period_end | TEXT | ISO 8601 |
| created_at | TEXT | ISO 8601 |
| updated_at | TEXT | ISO 8601 |

### `transactions`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT | PK |
| user_id | TEXT | FK → users(id) |
| post_id | TEXT | FK → posts(id) (marketplace only) |
| stripe_session_id | TEXT | UNIQUE |
| stripe_payment_intent_id | TEXT | |
| stripe_invoice_id | TEXT | UNIQUE（継続課金の請求単位） |
| type | TEXT | `subscription` or `marketplace` |
| plan_id | TEXT | (subscription only) |
| amount | INTEGER | Amount in JPY |
| currency | TEXT | Default: `jpy` |
| status | TEXT | `pending`, `completed`, `failed`, `refunded` |
| metadata | TEXT | JSON (optional) |
| created_at | TEXT | ISO 8601 |

`users.stripe_customer_id` に Stripe Customer を保持し、checkout ごとの
Customer 二重作成を防ぐ。

`stripe_events` は Webhook の `event.id` を記録し、Stripe の再送を冪等に処理する。

---

## Webhook Events

| Event | Action |
|-------|--------|
| `checkout.session.completed` | サブスク: `subscriptions` を upsert / 取引を `completed` |
| `checkout.session.async_payment_succeeded` | 同上（非同期決済） |
| `checkout.session.expired` | 保留中の取引を `failed` |
| `customer.subscription.created` | `subscriptions` を upsert |
| `customer.subscription.updated` | status / plan / 解約予定 / 請求期間を更新 |
| `customer.subscription.deleted` | status を `canceled` に変更 |
| `invoice.payment_succeeded` | 請求期間を更新し、支払い履歴を記録 |
| `invoice.payment_failed` | status を `past_due` に変更 |
| `charge.refunded` | 該当取引を `refunded` に変更 |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe API シークレットキー |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 署名シークレット |
| `STRIPE_PRICE_FLXIA_PLUS` | Flaxia+ の Stripe Price ID（未設定時は `price_data` にフォールバック） |
| `BASE_URL` | 成功/キャンセル/ポータル URL のベース |

### Stripe Dashboard 側の準備

1. 商品「Flaxia+」＋月次 Price（JPY 150）を作成し Price ID を取得
2. Customer Portal を有効化（解約・支払い方法変更・請求履歴）
3. Webhook `https://flaxia.app/api/billing/webhook` を登録（上表のイベント）
4. secrets 投入: `npx wrangler pages secret put STRIPE_SECRET_KEY` など
