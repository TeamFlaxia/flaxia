# GEMINI.md — flaxia SNS Worker拡張 (Flaxia Crowd オーケストレーター)

## このリポジトリの目的

既存の Flaxia SNS（flaxia.app）の Cloudflare Workers（Hono）に、
**Flaxia Crowd オーケストレーター機能**を追加する。

Flaxia Crowdとは、一般ウェブサイトの訪問者ブラウザをノードとして使う
分散非同期処理サービスである。このWorkerはそのコントロールプレーンとなる。

## 技術スタック

- Runtime: Cloudflare Workers
- Framework: Hono
- 状態管理: Cloudflare Durable Objects
- キュー: Cloudflare Queues（または Durable Objects で代替）
- ストレージ: Cloudflare KV（ノードメタ情報）
- Signaling: WebSocket（Hono の `upgradeWebSocket` を使用）

## 既存コードへの影響方針

- 既存のHonoルーティングを**壊さないこと**
- 新機能は `/crowd/` プレフィックス以下に集約する
- Durable Objects は新規クラスとして追加する
- 既存の Worker の `wrangler.toml` に追記する形で対応

## 実装すべき機能

詳細は各 `docs/` 配下のMarkdownを参照。

1. `docs/01-routing.md` — Honoルーティング追加方針
2. `docs/02-signaling.md` — WebRTC Signalingサーバー
3. `docs/03-task-queue.md` — タスクキュー管理（Durable Objects）
4. `docs/04-node-registry.md` — ノード登録・死活管理
5. `docs/05-result-collector.md` — 結果収集・コールバック通知
6. `docs/06-wrangler.md` — wrangler.toml 追記内容

## コーディング規約

- TypeScript strict mode
- Hono の型安全ルーティングを使うこと（`app.get<Env>()`）
- Durable Objects は1クラス1責務
- WebSocketのメッセージはすべてJSONスキーマを定義してから実装する
- エラーはすべて `{ error: string, code: string }` 形式で返す

## ディレクトリ構成（追加分のみ）

```
src/
└── crowd/
    ├── index.ts          # Honoサブアプリ（/crowd/ 以下をここに集約）
    ├── signaling.ts      # WebRTC Signalingハンドラ
    ├── task.ts           # タスクCRUD
    ├── node-registry.ts  # ノード登録・管理
    ├── result.ts         # 結果収集
    └── durable/
        ├── TaskQueue.ts        # Durable Object: タスクキュー
        └── NodeManager.ts      # Durable Object: ノード管理
```

## 開発時の注意

- Durable Objects はローカル `wrangler dev` で動作確認できる
- WebSocketのテストは `wscat` を使うこと
- Signalingのメッセージフォーマットは `@flaxia/node` と厳密に合わせること
  （`docs/02-signaling.md` にスキーマを記載する）
