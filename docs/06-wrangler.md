# 06. wrangler.toml 追記内容

## 概要

既存の `wrangler.toml` に以下のセクションを**追記**する。
既存設定は一切変更しない。

## 追記内容

```toml
# ───────────────────────────────────────────
# Flaxia Crowd — 追記分
# ───────────────────────────────────────────

[[durable_objects.bindings]]
name = "TASK_QUEUE"
class_name = "TaskQueue"

[[durable_objects.bindings]]
name = "NODE_MANAGER"
class_name = "NodeManager"

[[migrations]]
tag = "v2-crowd"
new_classes = ["TaskQueue", "NodeManager"]

[[kv_namespaces]]
binding = "CROWD_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # wrangler kv:namespace create CROWD_KV で取得

# ノードトークン・タスク結果の保存に使用
```

## バインディング一覧

| バインディング名 | 種別 | 用途 |
|----------------|------|------|
| `TASK_QUEUE` | Durable Object | タスクキュー管理 |
| `NODE_MANAGER` | Durable Object | ノード接続管理 |
| `CROWD_KV` | KV Namespace | トークン・結果キャッシュ |

## 環境変数（secrets）

以下は `wrangler secret put` で設定する（wrangler.tomlには書かない）：

```bash
wrangler secret put CROWD_API_SECRET    # SDK認証用シークレット
wrangler secret put CROWD_HMAC_SECRET   # コールバック署名用
```

## KV Namespace の作成コマンド

```bash
# 本番
wrangler kv:namespace create CROWD_KV

# ローカル開発用（preview）
wrangler kv:namespace create CROWD_KV --preview
```

作成後に表示される `id` を `wrangler.toml` の該当箇所に記入する。

## デプロイ確認

```bash
wrangler deploy --dry-run   # 差分確認
wrangler deploy             # 本番反映
```

## ローカル開発

```bash
wrangler dev   # Durable Objects・KVともにローカルエミュレートされる
```

WebSocketのテスト：

```bash
npx wscat -c "ws://localhost:8787/crowd/signal?token=test-token"
```
