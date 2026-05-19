# flaxia-backend 実装メモ

## 概要
`flaxia-backend` は、Flaxia プロジェクトの分散非同期タスク処理を支えるバックエンド Worker です。主に Durable Objects をホストし、ページプロジェクトからバインドして利用される構成をとっています。

## 現状の実装状態 (2026/05/19 時点)

### 1. 責務
- **ActivityPub Queue**: 活動通知（ActivityPub の Inbox/Delivery）を処理するためのキューコンシューマーが含まれています。

### 2. 設定
- `wrangler.toml.worker` にて DO クラスの登録とマイグレーションタグ (`v1`) が設定されており、正常にデプロイ可能な状態です。
- ページプロジェクト (`wrangler.toml`) から `script_name = "flaxia-backend"` を指定してバインドされています。

### 3. 今後の課題・Next Steps
1. **シグナリングサーバーの接続**: `docs/02-signaling.md` に基づいた Signaling ハンドラの統合が必要です。
2. **型安全性の強化**: RPC インターフェースの型定義をクライアント（SDK）と共通化し、DO 呼び出しの安全性を高める必要があります。

## メモ
- `functions/queue-worker.ts` が backend Worker のメインエントリーポイントとなっています。
- デプロイ環境の制約上、Pages プロジェクトとの Worker バインディングを利用しています。開発時は `flaxia-backend` と `flaxia` (Pages) の両方のデプロイ状態に注意すること。

