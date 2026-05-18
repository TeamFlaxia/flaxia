# 01. Honoルーティング追加方針

## 方針

既存の Flaxia SNS の Hono アプリに対して、`/crowd/` プレフィックス以下に
サブアプリをマウントする形で追加する。既存ルートへの影響はゼロ。

## 実装イメージ

```typescript
// src/index.ts（既存）に追記するだけ
import { crowdApp } from './crowd/index'

app.route('/crowd', crowdApp)
```

## crowdApp が持つルート一覧

| Method | Path | 説明 |
|--------|------|------|
| GET | `/crowd/signal` | WebSocket Upgradeエンドポイント（Signalingサーバー） |
| POST | `/crowd/tasks` | タスク投入（@flaxia/sdk から呼ばれる） |
| GET | `/crowd/tasks/:id` | タスク状態取得 |
| POST | `/crowd/tasks/:id/result` | ノードからの結果投稿（内部用） |
| GET | `/crowd/nodes` | 接続中ノード一覧（デバッグ用・本番は認証必須） |
| POST | `/crowd/nodes/register` | ノード登録（@flaxia/node から呼ばれる） |

## 認証方針

- `/crowd/tasks` への投入はAPIキー認証（`Authorization: Bearer <key>`）
- `/crowd/signal` はノードトークン認証（クエリパラメータ `?token=`）
- 内部エンドポイント（`/result`）はWorker内部からのみ呼ぶ設計にする

## エラーレスポンス形式

すべてのエラーは以下の形式で統一する：

```json
{
  "error": "human readable message",
  "code": "TASK_NOT_FOUND"
}
```

## コードコード一覧

| code | 意味 |
|------|------|
| `UNAUTHORIZED` | 認証失敗 |
| `TASK_NOT_FOUND` | タスクIDが存在しない |
| `NODE_NOT_FOUND` | ノードIDが存在しない |
| `QUEUE_FULL` | キューが満杯 |
| `INVALID_PAYLOAD` | リクエストボディ不正 |
