# 02. WebRTC Signalingサーバー

## 概要

Cloudflare Workers の WebSocket サポートを使い、
`/crowd/signal` エンドポイントで WebRTC の Offer/Answer/ICE 交換を仲介する。

実装には Hono の `upgradeWebSocket` を使用する。

## 接続フロー

```
[Node]                  [Worker: Signaling]            [SDK Client]
  |                            |                             |
  |-- WS Connect (token) ----->|                             |
  |<- { type: "hello", nodeId }|                             |
  |                            |<-- POST /crowd/tasks -------|
  |<- { type: "task", taskId, |                             |
  |     offer: RTCSessionDesc }|                             |
  |-- { type: "answer",  ----->|                             |
  |     taskId, answer }       |                             |
  |-- { type: "ice", --------->|                             |
  |     taskId, candidate }    |                             |
  |                            |--- callback / polling ----->|
  |-- { type: "result", ------>|                             |
  |     taskId, payload }      |-- { status: done, result }->|
```

## WebSocketメッセージスキーマ

### Worker → Node

```typescript
// 接続確立時
type HelloMessage = {
  type: 'hello'
  nodeId: string
}

// タスク割り当て
type TaskAssignMessage = {
  type: 'task'
  taskId: string
  workload: WorkloadType  // 'ai-inference' | 'image-process' | 'file-convert'
  payload: unknown        // ワークロード固有データ
  offer: RTCSessionDescriptionInit
  timeoutMs: number
}

// Ping（死活確認）
type PingMessage = {
  type: 'ping'
}
```

### Node → Worker

```typescript
// Answer返却
type AnswerMessage = {
  type: 'answer'
  taskId: string
  answer: RTCSessionDescriptionInit
}

// ICE Candidate
type IceCandidateMessage = {
  type: 'ice'
  taskId: string
  candidate: RTCIceCandidateInit
}

// 処理結果
type ResultMessage = {
  type: 'result'
  taskId: string
  success: boolean
  payload: unknown
  processingMs: number
}

// Pong
type PongMessage = {
  type: 'pong'
  nodeId: string
  cpuLoad: number   // 0.0 - 1.0
}
```

## Durable Object との連携

Signalingハンドラは `NodeManager` Durable Object に以下を委譲する：

- ノードのWebSocket接続の保持
- タスク割り当て（どのノードにどのタスクを振るか）
- Ping/Pongによる死活確認（30秒間隔）

## 実装上の注意

- `upgradeWebSocket` は Cloudflare Workers でのみ動作する。ローカルの
  `wrangler dev` では動くが、Node.js環境では動かない
- WebSocketのメッセージはすべて `JSON.stringify` / `JSON.parse` で扱う
- タイムアウト（`timeoutMs`）を超えたタスクは `TaskQueue` が自動で
  再キューイングする（`03-task-queue.md` 参照）
