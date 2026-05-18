# 03. タスクキュー管理（Durable Objects）

## 概要

`TaskQueue` Durable Object がタスクのライフサイクル全体を管理する。

## タスクのステータス遷移

```
PENDING → ASSIGNING → PROCESSING → DONE
                  ↘            ↘
                  TIMEOUT →  PENDING（再キュー）
                             （最大3回）
                  FAILED（3回失敗で確定）
```

## Durable Object: TaskQueue

### 内部ストレージ構造（DO Storage）

```typescript
// キー設計
`task:${taskId}`          → TaskRecord
`queue:pending`           → taskId[] (JSON)
`queue:processing`        → taskId[] (JSON)
```

### TaskRecord 型定義

```typescript
type TaskStatus = 'pending' | 'assigning' | 'processing' | 'done' | 'failed'

type WorkloadType = 'ai-inference' | 'image-process' | 'file-convert'

type TaskRecord = {
  id: string
  status: TaskStatus
  workload: WorkloadType
  payload: unknown
  createdAt: number       // unixtime ms
  assignedAt?: number
  completedAt?: number
  assignedNodeId?: string
  retryCount: number      // max 3
  timeoutMs: number       // デフォルト 30000
  callbackUrl?: string    // 完了時にPOSTする先（SDK側）
  result?: unknown
  error?: string
}
```

### 公開メソッド（RPC or fetch）

| メソッド | 説明 |
|---------|------|
| `enqueue(task)` | タスクをPENDINGキューに追加 |
| `assign(taskId, nodeId)` | ASSIGNING→PROCESSINGに遷移 |
| `complete(taskId, result)` | PROCESSING→DONEに遷移・callback発火 |
| `fail(taskId, error)` | 失敗処理・リトライ判定 |
| `getTask(taskId)` | タスク取得 |
| `getPending()` | PENDING一覧取得 |
| `checkTimeouts()` | タイムアウト確認・再キュー |

## タイムアウト処理

Durable Objects の Alarm API を使用する：

```typescript
// タスクenqueue時にAlarmをセット
await this.state.storage.setAlarm(Date.now() + task.timeoutMs)

// alarm() ハンドラでタイムアウト確認
async alarm() {
  await this.checkTimeouts()
  // 次のAlarmをセット（処理中タスクがあれば）
}
```

## 冗長化方針

Phase 1では冗長配布（同一タスクを複数ノードへ）は**行わない**。
シンプルに1タスク1ノードでリトライで対応する。

Phase 2以降で結果照合による冗長実行を検討する。
