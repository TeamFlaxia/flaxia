# Recommendation & Dwell-time RL

Flaxia の Arcade は TikTok/Shorts 風の縦スクロール全画面フィードです。本ドキュメントは
ユーザープロファイリングと、滞在時間 (dwell time) 最大化のための強化学習 (RL) 方針を説明します。

## 概要

3 層構成で、`収集 → 推論 → 学習` のループを回します。

| 層 | 役割 | 実装 |
|---|---|---|
| 収集 | すべての閲覧（スキップ含む）とエンゲージメントを記録 | `arcade_events` + `user_profiles` |
| 推論 | エッジでパーソナライズ表示を決める | `functions/api/[[route]].ts` の `/api/games` |
| 学習 | データセットから方策を学習（外部実行） | HuggingFace データセット + 外部トレーニング |

トレーニングは Flaxia のインフラでは実行しません。Workers はステートレスなエッジであり、
深層 RL の学習には不向きです。そのため、**オンラインの軽量コンテキスチュアル・バンディット**で
配信し、**オフライン RL 用データセット**を HuggingFace に公開して外部で学習します。

## 1. プロファイリング

### 生イベント (`arcade_events`)
`src/components/ArcadePage.ts` は、表示されたすべてのゲームについてイベントを
`POST /api/games/events` へバッチ送信します（`sessionId` 付き）。

- `view` — 表示。**2 秒未満のスキップも `did_skip=1` として記録**（負例）。
- `fresh` / `reply` / `fullscreen` / `share` — ポジティブなエンゲージメント。

### マテリアライズ済みプロファイル (`user_profiles`)
`interest_vec`（重み付き平均の 1024 次元ベクトル）を DB に保存し、
`loadOrComputeInterestVector()` が 5 分 TTL でキャッシュします。Fresh、ブックマーク、返信、
シェア、高滞在 (dwell>5s) のプレイから重み付きで導出されます。

## 2. 推論: コンテキスチュアル・バンディット (LinUCB)

`functions/lib/linucb.ts` に実装。`/api/games?recommended=true` で既存ヒューリスティックと
ブレンドされます。

- 各候補の 1024 次元埋め込みを **決定的ランダム射影** で 64 次元に圧縮（JL）。
- ユーザーごとの状態 `A⁻¹`（64×64）, `b`, `t` を `bandit_state` に保存し、
  Sherman-Morrison でオンライン更新。
- スコア = `θᵀx + α·sqrt(xᵀA⁻¹x)`（期待報酬 + 探索ボーナス）。
- 最終スコア = `λ·ヒューリスティック + (1−λ)·バンディット正規化スコア`。

### 設定 (KV)
`arcade:bandit:config` (JSON) で動作を制御します。**デフォルトは無効**です。

```json
{ "enabled": true, "alpha": 0.6, "dim": 64, "srcDim": 1024, "seed": 20260701, "lambda": 0.6 }
```

- `enabled` — バンディットを有効化。
- `alpha` — 探索強度（大きいほど探索重視）。
- `lambda` — ヒューリスティックへの重み（1 で完全に無効化と同等）。
- `dim` — 投影次元（8〜256）。
- `srcDim` — ソース埋め込み次元（通常 1024）。
- `seed` — 射影行列の決定シード（**変更すると過去の学習状態が無効化**されます）。

### 学習済み prior (`arcade:bandit:prior`)

オフライン学習で得た**グローバル方策**を KV `arcade:bandit:prior` にデプロイすると、
`bandit_state` を持たない新規ユーザーの状態を初期シードできます
（`createStateFromPrior`）。prior はユーザー非依存のコールドスタート方策で、
`arcade:bandit:config` と別キーに分離されており、デフォルト KV 設定は無効のまま維持されます。

スキーマ (`BanditPrior`):
```json
{
  "v": 1, "dim": 64, "seed": 20260701, "srcDim": 1024,
  "theta": [...], "lambda0": 1.0, "trainedAt": "...", "records": 12345
}
```

- シードは `A⁻¹ = (1/λ₀)·I`, `b = λ₀·θ₀` として表現され、初期 posterior mean が `θ₀` と一致。
- `λ₀` が大きいほどオンライン更新が prior に強くアンカーされます。
- **投影設定 (`seed`/`srcDim`/`dim`) が有効な config と一致する場合のみ適用**されます。

設定例:
```bash
npx wrangler kv key put --binding=CACHE 'arcade:bandit:config' '{"enabled":true,"alpha":0.6,"dim":64,"lambda":0.6,"seed":20260701}'
```

### 報酬
`/api/games/events` が `eventReward()` で報酬を計算し `bandit_state` を更新します。

| イベント | 報酬 |
|---|---|
| view (dwell) | `min(dwell_ms/30000, 1)`（スキップはほぼ 0） |
| fresh / reply | 1.0 |
| share | 0.8 |
| fullscreen | 0.6 |

## 3. HuggingFace データセット

`scheduled` ハンドラ（`functions/queue-worker.ts`）が毎日 04:00 UTC に
`functions/lib/dataset-export.ts` の `runDatasetExport()` を実行します
（`wrangler.toml.worker` の `[triggers] crons`）。

### プライバシー
- `user_id` / `session_id` / `post_id` は **回転ソルト付き SHA-256** で匿名化。
- 本文・メール・bio 等の PII は一切含めません。
- ソルトは KV (`arcade:dataset:salt`) に保存され、ローテーション可能。

### スキーマ
各行 = セッション内で表示された 1 ゲーム（スキップ含む）。

```
user_id, session_id, post_id, game_type, position, event_type,
dwell_ms, did_skip, is_fullscreen, swipe_velocity, hour, created_at,
post_embedding (1024-d), label (reward)
```

### アップロード (fail-graceful)
- 成果物 (JSONL) は常に R2 (`flaxia-exports`) に書き込み。
- `HF_TOKEN` secret と `HF_REPO` var が設定されている場合のみ HuggingFace へアップロード。
- 設定がない場合はログを出してスキップ（チェックポイントは進む）。

設定:
```bash
npx wrangler secret put HF_TOKEN --config wrangler.toml.worker
# wrangler.toml.worker の [vars] に HF_REPO を追加
```

チェックポイントは KV (`arcade:dataset:checkpoint`) に保存され、再開可能です。

## 4. 外部トレーニング手順

方策 1 (LinUCB 再学習) は `scripts/train_linucb.py` で実行します。
このスクリプトは `functions/lib/linucb.ts` の `mulberry32` と ±1 JL 射影を
**ビット完全に移植**しており、オンライン配信と同じ射影空間で回帰を学習します。
必要なのは numpy のみです（HF ソースを使う場合は `datasets` も必要）。

```bash
# R2 成果物 (JSONL) から学習
python3 scripts/train_linucb.py --dataset path/to/arcade-dwell-<ts>.jsonl \
  --dim 64 --seed 20260701 --src-dim 1024 --out prior.json

# HuggingFace データセットから学習（--seed/--dim/--src-dim は online config と一致させる）
python3 scripts/train_linucb.py --dataset youruser/flaxia-arcade-dwell \
  --dim 64 --seed 20260701 --src-dim 1024 --out prior.json

# 射影の一致確認（Node の出力と突き合わせる）
python3 scripts/train_linucb.py --dataset /dev/null --check-projection
```

- 回帰は `A = XᵀX + λ·I`, `θ = A⁻¹Xᵀy`（ridge）。`--val-fraction` で train/val RMSE を表示。
- 出力 `prior.json` は `parseBanditPrior` を通る形の `BanditPrior`。
- フィンガープリント (`fingerprint`) は `v/dim/seed/srcDim/theta` の SHA-256 先頭 16 桁で、
  デプロイ時の整合確認に使えます。

### デプロイ

`scripts/deploy-prior.mjs` で KV に書き込みます。serving 側の検証関数を再利用するため
`--experimental-strip-types` を付けて実行します。

```bash
node --experimental-strip-types scripts/deploy-prior.mjs \
  --kv <namespace-id> --file prior.json

# バンディット設定も同時にデプロイする場合
node --experimental-strip-types scripts/deploy-prior.mjs \
  --kv <namespace-id> --file prior.json --config bandit-config.json
```

- `--kv` には KV ネームスペース ID を指定します（`wrangler.toml` の `[[kv_namespaces]]` `id`）。
- 優先度は `arcade:bandit:prior`、設定は `arcade:bandit:config` に書き込まれます。
- **設定を明示しない限り `arcade:bandit:config` は無効のまま**です。

方策 2 (深層 RL) — フィード上のセッションを系列とみなし、累積滞在を最大化する方策
（例: 系列レコメンダー、学習済み方策のロールアウト）を学習し、結果を KV/D1 にデプロイします。

## 実運用上の注意

- バンディットは**デフォルト無効**。`arcade:bandit:config` で段階的に有効化。
- `seed` 変更は射影行列を変えるため学習状態をリセットしてください。
- 大量の `bandit_state` 書き込みを避けるため、報酬更新はイベントバッチごとに
  1 回の読み書きにまとめています。

## Semantic topic signals via Crowd

`functions/lib/topics.ts` defines 12 canonical topic labels with bilingual
reference descriptions, plus a miscellaneous reference. These descriptions
are embedded by Crowd's existing `vector-embed` workload using
`Qwen/Qwen3-Embedding-0.6B`. Posts use that same embedding model. Cosine
similarity assigns up to three labels without keyword matching; it is a
semantic classifier, not LLM-generated free-form tags. No Crowd node or SDK
change is required. Crowd's separate `ai-inference` workload exists, but a
new zero-shot or generative model would require node model registration and
additional pipeline options.

Apply `0110_semantic_topics.sql` before deploying this code. It stores prototype
embeddings and automatic post tags separately from user-authored `hashtags`.
Prototype descriptions/model compatibility are versioned by `TOPIC_VERSION`.
All reference vectors must be ready before classification starts. Initial
similarity cutoff is 0.5; labels within 0.08 of the best score are eligible.
The miscellaneous reference winning yields no labels. Similarities are not
probabilities: thresholds and multilingual quality require real-model evaluation.

Topic maintenance runs in the background when global/tag/recommendation/trend
feeds are read, at most once per ten seconds per worker isolate. Up to three
prototype tasks are submitted per pass. D1 leases and signed callback tokens
prevent duplicate claims and stale task results; missing, failed or invalid
results retry after an exponential backoff (10-minute minimum, capped at
64 minutes). `CROWD_SCREENING_DISABLED=1` also stops maintenance submissions.
The first rollout requires active Crowd nodes and receives labels progressively;
feed responses never wait for inference and retain manual-tag and existing
recommendation signals while classification is pending or Crowd is unavailable.

Database triggers enqueue embeddings for publishing paths and edits, clear
labels and old embeddings on text changes, and remove vector/outbox rows on
deletion. New embedding callback URLs include the submitted text's SHA-256.
Callbacks for a different current text are ignored; updates also compare the
text inside the D1 statement. Legacy unsigned-in-content vectors remain usable
by the existing recommender but cannot supply semantic labels. They are
requeued in bounded slices, or via `/api/admin/backfill-embeddings`. Existing
submission retry caps still apply; operators can inspect/reset exhausted
`pending_embeddings` attempts when recovering an extended outage.

Stored compatible post vectors are classified in batches of 50 during
maintenance and callback handling. AI labels and normalized manual hashtags
are deduplicated for trend counts, tag browsing and interest signals.
Percentages use the actual sampled top-level published, visible post count.
Automatic tag browsing uses persisted tags across the entire history.

For You derives a topic profile from up to 80 distinct visible, unblocked posts
Fresh-ed or bookmarked within the preceding 90 days. Bookmarks weigh 1.5 and
Fresh weighs 1; overlapping actions use the strongest weight. Interest decays
with a 30-day half-life, and each source post's weight is split across its tags.
The strongest matching topic produces a bounded affinity score. Self-posts do
not train this profile. Up to 100 topic matches from the latest 1,000 eligible
posts in the existing 14-day candidate window supplement the existing sources.
When topic history exists, 30% of the base score is affinity and 70% is the
existing ranking. The existing visibility, trust, duplicate, author diversity,
impression/history and pagination rules still apply. Users without topic
history retain the existing ranking. Validate engagement and classification
quality before claiming measured recommendation improvements.

Tests use synthetic vectors to verify callback authentication, model/vector
validation, persistence, edit invalidation, tag browsing and ranking. They do
not download or execute the real model and do not measure semantic accuracy.
