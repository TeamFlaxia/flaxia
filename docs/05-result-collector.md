# 05. 結果収集・コールバック通知

## 概要

ノードが処理を完了したら、結果をWorkerに返却し、
依頼者（@flaxia/sdk）に非同期で通知する。

## 結果返却フロー

```
[Node] --{ type: 'result', taskId, payload }--> [NodeManager DO]
                                                      ↓
                                               [TaskQueue DO]
                                               complete(taskId, result)
                                                      ↓
                                          callbackUrl があれば POST
                                          なければ KV に結果を保存
```

## コールバック方式（SDKがcallbackUrlを指定した場合）

```typescript
// TaskQueue.complete() 内で実行
await fetch(task.callbackUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    taskId: task.id,
    status: 'done',
    result: task.result,
    processingMs: task.completedAt - task.assignedAt,
  })
})
```

## ポーリング方式（SDKがcallbackUrlを指定しない場合）

結果をKVに保存し、SDKがポーリングで取得する：

```
GET /crowd/tasks/:id
→ { taskId, status, result?, error?, processingMs? }
```

KVのキー：`result:${taskId}`、TTL: 1時間

## 結果レスポンス型

```typescript
type TaskResult = {
  taskId: string
  status: 'pending' | 'processing' | 'done' | 'failed'
  result?: unknown        // done時のみ
  error?: string          // failed時のみ
  processingMs?: number   // done/failed時
  retryCount: number
}
```

## 失敗時の処理

- `retryCount < 3` → TaskQueue が自動でPENDINGに戻す
- `retryCount >= 3` → status を `failed` に確定
  - callbackUrl があれば `{ status: 'failed', error }` をPOST
  - なければKVに保存

## セキュリティ

- コールバック先URLはHTTPSのみ許可
- コールバックには `X-Flaxia-Signature` ヘッダを付与（HMAC-SHA256）
  → SDKはこれを検証してなりすましを防ぐ
- 結果のKVは `result:${taskId}` のみ参照可能（タスクIDを知っている者のみ）
