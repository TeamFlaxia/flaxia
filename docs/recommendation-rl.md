# Recommendation Model

Flaxia の For You と Arcade は、**個人の好みベクトルを端末内でのみ復号し、候補の公開埋め込みと
突き合わせてクライアント側でランキング**します。サーバーは個人プロフィールを保存せず、
復号済みの好みベクトルも受け取りません。

## 1. プライバシー境界

| データ | 保存先 | サーバーが見えるか |
|---|---|---|
| 好みベクトル（1024次元 int8/float） | Vault item `recommendation_profile` / `reco-profile-v1`（AES-GCM） | ❌ 暗号文のみ |
| 候補投稿の埋め込み | `post_embeddings.embedding`（公開コンテンツ由来） | ✅ |
| 非パーソナルな base score | リクエスト時に算出 | ✅ |
| fresh / reply / share / dwell イベント | `freshs` / `arcade_events` など | ✅ |

**正直な限界:** 行動イベント自体はサーバーに残るため、運用者は行動ログから好みを近似的に
再構成できます。Vault が守るのは「明示的に構築した好みベクトル」という保存物であり、
観測可能な行動の秘匿ではありません。

## 2. プロフィールの構築

`GET /api/recommendations/profile-sources`（要ログイン）が、減衰付きのソースを返します。

- fresh、bookmark、reply、share、長めの dwell（`>5s`）
- 各ソースの投稿埋め込みを重み付き平均し、L2 正規化
- クライアントは結果を `src/lib/vault/recommendation-profile.ts` で Vault に保存

保存形式:

```json
{
  "v": 1,
  "dim": 1024,
  "vector": [0.012, -0.004, "..."],
  "sourceCount": 42,
  "sourceVersion": "2026-11-06T00:00:00.000Z|42",
  "builtAt": "2026-11-06T00:00:00.000Z",
  "model": "weighted-mean-v1"
}
```

- Vault が未設定・ロック中・期限切れの場合はプロフィールを返さず、サーバーの
  非パーソナルランキングへフォールバックします。
- fresh などの操作後は `markRecommendationProfileDirty()` を呼び、次回取得時に再構築します。
- TTL は 15 分。

## 3. 候補 API

```http
GET /api/posts/recommended?client_rank=1&include_vectors=1&limit=100&cursor=...
GET /api/games?recommended=true&client_rank=1&include_vectors=1&limit=120&offset=0
```

`client_rank=1` または `include_vectors=1` で、候補レスポンスに次が追加されます。

```json
{
  "posts": [],
  "vectors": {
    "<post_id>": { "scale": 0.031, "data": "..." }
  },
  "vector_meta": { "dim": 1024, "encoding": "int8" },
  "base_scores": { "<post_id>": 0.42 },
  "next_cursor": "..."
}
```

- `vectors` は int8 + per-vector scale + base64（`src/lib/recommendation/vector-codec.ts`）。
- `base_scores` は freshness、dwell、popularity、未プレイ探索などの非パーソナル信号。
- `client_rank` を付けない既存クライアントには従来どおりサーバー順で返します。

## 4. クライアントランキング

`src/lib/recommendation/rank.ts` の `rankCandidates()`:

1. `base_score` とコサイン類似度を `0.55 : 0.45` で合成
2. MMR（`lambda=0.75`）で類似候補の重複を抑制
3. 同一著者は最大 2 件

プロフィールがない場合はサーバーの `base_score` 順を維持します。Arcade の `initialId` は
クライアント側で先頭へ移動します。

## 5. サーバー側の役割

- For You: following / trending / recent の候補を統合し、非パーソナルスコアで並べる。
- Arcade: dwell 統計、popularity、未プレイ、freshness で base score を作る。
- どちらも個人プロフィールを読まない。

## 6. 廃止したもの

- `user_profiles.interest_vec` と `loadOrComputeInterestVector()`
- サーバー側 LinUCB 配信（`bandit_state`、`/api/games` 内のブレンド）
- `POST /api/games/events` からの bandit 報酬更新

`migrations/0130_drop_server_recommendation_profiles.sql` が個人状態テーブルを削除します。
`functions/lib/linucb.ts` はオフライン研究・データセット変換用に残していますが、
リクエスト処理からは呼びません。`arcade_events` と dwell ログは、研究用データセット生成に引き続き利用できます。

## 7. デプロイ時の確認

`AUTH_AUTHORITY_MODE=flaxia-auth` では Vault item の kind 許可リストが Flaxia Auth 側にも
あります。`recommendation_profile` を追加できない場合、プロフィール保存は失敗しますが、
クライアントはそのセッションのメモリ内ベクトルでランキングを継続します。リリース前に
Auth 側の allowlist を確認してください。
