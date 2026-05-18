# 04. ノード登録・死活管理

## 概要

`NodeManager` Durable Object が接続中のブラウザノードを管理する。
WebSocket接続の保持、タスク割り当て、死活確認を担当する。

## Durable Object: NodeManager

### NodeRecord 型定義

```typescript
type NodeStatus = 'idle' | 'busy' | 'disconnected'

type NodeCapability = 'ai-inference' | 'image-process' | 'file-convert'

type NodeRecord = {
  id: string
  status: NodeStatus
  connectedAt: number
  lastPongAt: number
  capabilities: NodeCapability[]
  cpuLoad: number         // 0.0 - 1.0（最新のPongから）
  currentTaskId?: string
  userAgent: string       // デバッグ用
}
```

### 内部ストレージ

```typescript
// WebSocket接続はメモリ上で保持（DO内）
private connections: Map<string, WebSocket>

// ノードメタはDO Storageに保存
`node:${nodeId}` → NodeRecord
`nodes:idle`     → nodeId[] (JSON)
```

### 公開メソッド

| メソッド | 説明 |
|---------|------|
| `registerNode(ws, capabilities)` | ノード登録・WebSocket保持 |
| `unregisterNode(nodeId)` | ノード切断処理 |
| `pickNode(workload)` | タスクに適したIDLEノードを選択 |
| `assignTask(nodeId, task)` | ノードにタスクメッセージを送信 |
| `handlePong(nodeId, cpuLoad)` | Pong受信・死活更新 |
| `getIdleNodes()` | IDLE状態のノード一覧 |

## ノード選択アルゴリズム（Phase 1）

シンプルに以下の順で選ぶ：

1. `capabilities` に対象 `workload` が含まれるノードに絞る
2. `cpuLoad` が最も低いノードを選ぶ
3. 同率なら `connectedAt` が古い順（先着優先）

## 死活確認

```
Worker → Node: { type: 'ping' }   （30秒ごと）
Node → Worker: { type: 'pong', cpuLoad }

最後のPongから60秒経過 → disconnectedとしてunregister
```

Durable Objects の Alarm API で30秒ごとにPingを送る：

```typescript
async alarm() {
  await this.pingAll()
  await this.checkStaleNodes()
  await this.state.storage.setAlarm(Date.now() + 30_000)
}
```

## ノードトークン

`/crowd/signal` へのWebSocket接続時に `?token=` で認証する。

- トークンはKVに保存（`node-token:${token}` → `{ siteId, createdAt }`）
- `@flaxia/node` 初期化時に `/crowd/nodes/register` を叩いてトークンを取得
- トークンの有効期限は24時間（再接続時に自動更新）
