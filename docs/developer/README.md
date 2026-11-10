# Flaxia 開発者ドキュメント

Flaxia の外部開発者（ゲーム作者・連携アプリ開発者・コントリビュータ）向けのドキュメントです。
Flaxia の API を一か所にまとめ、用途別に辿れるようにしています。

> 用語は [Before_implementing.md](../../Before_implementing.md) の用語集を参照してください。
> _arch_ 全体像は [architecture.md](../architecture.md) 、サンドボックスの設計は [sandbox.md](../sandbox.md) を参照してください。

---

## 目次

| ドキュメント | 対象 | 内容 |
|---|---|---|
| [Game API](game-api.md) | ゲーム作者 | サンドボックスゲームが実装する**契約**。フレームプロトコル、ケーパビリティ、制約 |
| [Game SDK](sdk.md) | ゲーム作者 | `@flaxia/game-sdk` の使い方。マルチプレイ・スコア・フルスクリーンを数行で |
| [REST API](rest-api.md) | 連携アプリ開発者 | `flaxia.app` の全 REST エンドポイント |
| [ゲームの公開](publishing.md) | ゲーム作者 | ZIP 仕様、アップロードフロー、審査・スキャン |

---

## はじめる前に

Flaxia は「投稿の中に生きているアプリ」を置く SNS です。ゲームは **投稿の添付ファイル** として
投稿され、`sandbox.flaxia.app` の隔离された iframe で実行されます。

```
flaxia.app（メイン）                sandbox.flaxia.app（サンドボックス）
┌────────────────────────────┐      ┌──────────────────────────────┐
│ タイムライン / Arcade       │      │ 信頼できないゲームを実行      │
│ ┌────────────────────────┐ │      │ ┌──────────────────────────┐ │
│ │ <iframe sandbox>       │◄─┼──────┼─┤ ゲーム（ZIP / HTML5）    │ │
│ │  allow-same-origin 禁止│ │ post │ │  Flaxia Game SDK         │ │
│ └────────────────────────┘ │Message└──────────────────────────┘ │
└────────────────────────────┘      └──────────────────────────────┘
```

ゲームからメインオリジンに直接アクセスすることはできません。すべての機能は
**Flaxia Game API**（型付き `postMessage` フレーム）経由で提供されます。

---

## ゲーム作者はここから

1. [Game API](game-api.md) を読んで、ゲームが使えるケーパビリティと契約を理解する
2. [Game SDK](sdk.md) を読んで、`/sdk/game.js` を1行読み込んで動かす
3. [ゲームの公開](publishing.md) を読んで、ZIP を投稿できる状態にする

## 連携アプリ開発者・コントリビュータはここから

- [REST API](rest-api.md) — 認証・投稿・ユーザー・マルチプレイ・メール・管理など全エンドポイント
- [authentication](../api.md#authentication) / [E2EE](../e2ee.md) — 認証と暗号化の設計
- [database.md](../database.md) — D1 スキーマ
- [deployment.md](../deployment.md) — ローカル環境と Cloudflare へのデプロイ

---

## フィードバック

ドキュメントの誤り・不足は GitHub Issue で報告してください。
ゲーム作者向けの改善提案は [Issue](https://github.com/TeamFlaxia/flaxia/issues) の
`developer-experience` ラベルで追跡しています。
