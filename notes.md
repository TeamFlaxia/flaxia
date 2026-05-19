# flaxia-backend 実装メモ

## 概要
`flaxia-backend` は、Flaxia プロジェクトの分散非同期タスク処理を支えるバックエンド Worker です。主に Durable Objects をホストし、ページプロジェクトからバインドして利用される構成をとっています。

## 現状の実装状態 (2026/05/19 時点)

### 1. 責務
- **Durable Objects のホスト**: `TaskQueue` および `NodeManager` の DO 定義を保持し、Pages プロジェクトから参照される RPC エンドポイントとして機能します。
- **ActivityPub Queue**: 活動通知（ActivityPub の Inbox/Delivery）を処理するためのキューコンシューマーが含まれています。

### 2. Durable Objects
- **TaskQueue (`src/crowd/durable/TaskQueue.ts`)**: 
  - 骨格のみ実装済み。RPC エンドポイント (`enqueue`, `assign`, `complete`, `fail`, `getTask`) の定義はありますが、内部ロジック（`alarm` によるタイムアウト管理やステータス遷移）は未実装です。
- **NodeManager (`src/crowd/durable/NodeManager.ts`)**:
  - クラスのみの定義で、具体的な機能ロジックはこれから実装する必要があります。

### 3. 設定
- `wrangler.toml.worker` にて DO クラスの登録とマイグレーションタグ (`v1`) が設定されており、正常にデプロイ可能な状態です。
- ページプロジェクト (`wrangler.toml`) から `script_name = "flaxia-backend"` を指定してバインドされています。

### 4. 今後の課題・Next Steps
1. **TaskQueue のロジック実装**: `enqueue`、`assign` などの DO メソッド内部の実装と、`alarm()` を使用したタスクのタイムアウト監視機構が必要です。
2. **NodeManager の実装**: ノードの死活監視と、タスクを割り当てるための登録管理機能が必要です。
3. **シグナリングサーバーの接続**: `docs/02-signaling.md` に基づいた Signaling ハンドラの統合が必要です。
4. **型安全性の強化**: RPC インターフェースの型定義をクライアント（SDK）と共通化し、DO 呼び出しの安全性を高める必要があります。

## メモ
- `functions/queue-worker.ts` が backend Worker のメインエントリーポイントとなっています。
- デプロイ環境の制約上、Pages プロジェクトとの Worker バインディングを利用しています。開発時は `flaxia-backend` と `flaxia` (Pages) の両方のデプロイ状態に注意すること。
