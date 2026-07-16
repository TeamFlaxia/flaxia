# Flaxia への実装提言: Twitterのアルゴリズムに学ぶ

本ドキュメントでは、TwitterのRecommendation Algorithmのコード解析から得られた知見を基に、Flaxiaが将来実装すべき推薦アルゴリズムの改善施策を提言する。

---

## Phase 0: 即効性のある改善（優先度: ★★★★★）

現状のコードを大きく変えずに、最小限の変更で最大の効果が得られる施策。

### 0.1 トレンドスコアの指数修正

**現状**: SQLite制限のため時間減衰が $(h+2)^2$（本来は1.5乗のところ2乗）

```sql
-- 現状: 指数のつもりが自乗になっている
numerator / ((hours + 2) * (hours + 2))
-- 本来: 
numerator / ((hours + 2) ^ 1.5)
```

**提案**: SQLiteでPOW相当をエミュレート:

```sql
-- SQLiteの制限回避: POW代替
score = numerator / POWER((hours + 2.0), 1.5)
```

ただし `POWER` はSQLiteにないため、アプリケーション側で計算するか、SQLの `EXP(1.5 * LN(hours + 2))` を使用:

```sql
score = ((fresh_count * 2.0 + reply_count * 3.0 + impressions * 0.1 + 1.0) /
         EXP(1.5 * LN((julianday('now') - julianday(p.created_at)) * 24.0 + 2.0)))
```

これにより新規投稿の露出が増え、トレンドの回転が速くなる。

### 0.2 エンゲージメントホットネスの更新トリガー

**現状**: `engagement_hotness` フィールドの更新ロジックが不在（初期値0のままの可能性）

**提案**: D1のトリガーまたはアプリケーションレベルでエンゲージメント発生時に自動更新:

```sql
-- Fresh/Reply/Impression のたびに更新
UPDATE posts SET
  engagement_hotness = fresh_count * 2.0 + reply_count * 3.0 + impressions * 0.1,
  fresh_count = fresh_count + 1
WHERE id = ?;
```

または、クエリ時に動的計算する（現在のtrendingと同じ方式）ことで、engagement_hotness 列自体を不要にできる。

### 0.3 興味ベクトルがない場合の改善

**現状**: 未ログインユーザーや新規ユーザーには完全非パーソナライズ

**提案**: 以下のフォールバック戦略を追加:

```typescript
// 1. IP/CFロケールベースの人気投稿
const locale = c.req.header('Accept-Language')?.split(',')[0] || 'en';

// 2. グローバル人気投稿 + 新着投稿のインタリーブ
//    50% popular + 50% fresh (過去24時間)
```

### 0.4 カーソルベースページネーションの安定化

**現状**: `score + created_at` 複合カーソルでスコアが小数の場合に不安定

**提案**: 安定ソートのためユニークIDをカーソルに含める:

```typescript
interface Cursor {
  score: number;
  created_at: string;
  id: string;  // タイブレーカー
}
// WHERE (score < :score) OR (score = :score AND created_at < :created_at)
//   OR (score = :score AND created_at = :created_at AND id < :id)
```

---

## Phase 1: 特徴量エンジニアリング（優先度: ★★★★☆）

Twitterのアプローチを参考に、Flaxiaのコンテキストに適した特徴量を追加。

### 1.1 投稿品質スコア

**Twitter参考**: HealthFilter, GrokSpamFilter

**Flaxia実装案**:

```sql
-- 投稿品質スコア (0.0 ~ 1.0)
quality_score = (
  -- テキスト長 (最適範囲: 50-280字)
  CASE WHEN length(text) BETWEEN 50 AND 280 THEN 1.0
       WHEN length(text) BETWEEN 10 AND 500 THEN 0.7
       ELSE 0.3 END *
  -- メディア有無
  CASE WHEN payload_key IS NOT NULL OR swf_key IS NOT NULL THEN 1.2
       ELSE 1.0 END *
  -- リンク有無 (スパムシグナル)
  CASE WHEN text LIKE '%http%' THEN 0.5 ELSE 1.0 END *
  -- 同一ユーザーの投稿頻度 (1時間以内の複数投稿は減衰)
  CASE WHEN recent_post_count_1h > 3 THEN 0.3 ELSE 1.0 END
)
```

### 1.2 著者品質スコア

**Twitter参考**: TweepCred (PageRank), AuthorFeatureHydrator

**Flaxia実装案**:

```typescript
// 著者品質 (0.0 ~ 1.0)
author_quality = (
  fresh_ratio * 0.4 +          // 投稿あたり平均Fresh率
  reply_rate * 0.3 +           // 返信率 (エンゲージメント)
  account_age_days / 365 * 0.2 + // アカウント熟成度
  completeness * 0.1            // プロフィール充実度
)
```

### 1.3 コンテンツタイプ別重み付け

**現状**: すべての投稿タイプが同一のスコアリング

**提案**: 投稿の `payload_key`（コンテンツタイプ）に応じて重みを調整:

```typescript
const TYPE_WEIGHTS = {
  swf:     { fresh: 3.0, reply: 4.0, impression: 0.05, dwell: 1.5 },  // ゲーム
  payload: { fresh: 2.0, reply: 2.0, impression: 0.1, dwell: 1.0 },   // アプリ
  null:    { fresh: 1.0, reply: 1.5, impression: 0.15, dwell: 0.5 },  // テキスト
};
```

### 1.4 暗黙的シグナルの収集基盤

**Twitter参考**: User Signal Service, Unified User Actions

**Flaxia実装案**: クライアントSDKで以下のイベントを収集:

```typescript
// src/lib/analytics.ts (新規)
interface UserEvent {
  type: 'scroll' | 'dwell' | 'click' | 'share_click';
  postId: string;
  userId: string;
  durationMs?: number;
  timestamp: number;
}

// D1 バッファにバッチ書き込み
const EVENT_TABLE = `
  CREATE TABLE user_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    duration_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_user_events_user ON user_events(user_id, created_at);
  CREATE INDEX idx_user_events_post ON user_events(post_id, event_type);
`;
```

---

## Phase 2: アルゴリズム改善（優先度: ★★★☆☆）

### 2.1 多相候補生成

**Twitter参考**: CR-Mixer (35 similarity engines), Tweet Mixer (22 candidate sources)

**Flaxia実装案**: 複数の候補生成戦略を並列実行:

```typescript
interface CandidateProvider {
  name: string;
  weight: number;  // 最終ミックス時の重み
  fetch(userId: string): Promise<Candidate[]>;
}

const providers: CandidateProvider[] = [
  // 1. フォローユーザーの最新投稿 (In-Network)
  { name: 'following', weight: 0.4, fetch: fetchFollowingPosts },
  // 2. ベクトル類似度 (パーソナライズ)
  { name: 'vector', weight: 0.25, fetch: fetchVectorRecommendations },
  // 3. トレンド (グローバル人気)
  { name: 'trending', weight: 0.15, fetch: fetchTrendingPosts },
  // 4. 探索 (新規投稿・未発見)
  { name: 'exploration', weight: 0.1, fetch: fetchExplorationPosts },
  // 5. ゲーム特化 (Arcade)
  { name: 'arcade', weight: 0.1, fetch: fetchGamePosts },
];
```

### 2.2 探索 vs 活用 (ε-greedy)

**Twitter参考**: ForYouExplorationTweetsCandidatePipelineConfig

**Flaxia実装案**:

```typescript
function shouldExplore(userId: string): boolean {
  // ユーザーの最近の行動に基づく探索確率
  const recency = getRecencyScore(userId);  // 最近のアクティビティ
  const diversity = getDiversityScore(userId); // 最近の閲覧多様性
  const baseEpsilon = 0.1; // 基本探索率10%

  // アクティブでないユーザーはより探索
  if (recency < 0.3) return Math.random() < 0.3;
  // 多様性が低いユーザーは探索促進
  if (diversity < 0.2) return Math.random() < 0.4;
  // 通常時
  return Math.random() < baseEpsilon;
}
```

### 2.3 フィードバックループとNegative Signal

**現状**: Fresh（肯定）のみ収集。Negative signal 不在。

**提案**:

```typescript
// 1. Negative feedback テーブル
CREATE TABLE negative_feedbacks (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  reason TEXT CHECK(reason IN ('not_interested', 'repetitive', 'spam', 'nsfw')),
  created_at TEXT DEFAULT (datetime('now'))
);

// 2. 推薦時に除外
const hiddenPostIds = await db.prepare(`
  SELECT post_id FROM negative_feedbacks WHERE user_id = ?
`).all();

// 3. 同一著者の除外 (3回以上のnegative)
const blockedAuthors = await db.prepare(`
  SELECT p.user_id FROM negative_feedbacks nf
  JOIN posts p ON p.id = nf.post_id
  WHERE nf.user_id = ?
  GROUP BY p.user_id HAVING COUNT(*) >= 3
`).all();
```

### 2.4 時間減衰関数の最適化

**現状**: 全投稿に一律の時間減衰

**提案**: コンテンツタイプ別の減衰曲線:

```typescript
// コンテンツタイプ別の半減期
const HALF_LIFE = {
  text:   { hours: 6,   decay: 'exponential' },  // テキストは早く飽きられる
  payload: { hours: 24,  decay: 'linear' },       // アプリは1日程度
  swf:    { hours: 48,  decay: 'logistic' },      // ゲームは2日程度持つ
};

function timeDecay(hoursAgo: number, type: string): number {
  const config = HALF_LIFE[type] || HALF_LIFE.text;
  switch (config.decay) {
    case 'exponential':
      return Math.pow(0.5, hoursAgo / config.hours);
    case 'linear':
      return Math.max(0, 1 - hoursAgo / config.hours);
    case 'logistic':
      return 1 / (1 + Math.exp((hoursAgo - config.hours) / (config.hours / 4)));
  }
}
```

---

## Phase 3: コミュニティ検出（優先度: ★★★☆☆）

### 3.1 簡易SimClusters: ローカルコミュニティ検出

**Twitter参考**: SimClusters (Louvain algorithm on follow graph)

Flaxiaの規模では本家SimClustersのような大規模クラスタリングは不要だが、**タグベースのコミュニティ検出**が実用的:

```sql
-- タグ共起グラフの構築
CREATE TABLE tag_cooccurrence (
  tag1 TEXT NOT NULL,
  tag2 TEXT NOT NULL,
  weight REAL DEFAULT 0,
  PRIMARY KEY (tag1, tag2)
);

-- 同じ投稿に出現するタグのペアをカウント
INSERT INTO tag_cooccurrence (tag1, tag2, weight)
SELECT
  LEAST(t1.value, t2.value) as tag1,
  GREATEST(t1.value, t2.value) as tag2,
  COUNT(*) as weight
FROM posts p,
  json_each(p.hashtags) t1,
  json_each(p.hashtags) t2
WHERE t1.value < t2.value
  AND p.created_at > datetime('now', '-30 days')
GROUP BY tag1, tag2;
```

### 3.2 興味ベクトルの進化

**現状**: Fresh + dwell のみの単純加重平均

**提案**: 時間減衰 + 行動タイプ別重み:

```typescript
function buildInterestVector(events: UserEvent[], embeddings: Map<string, number[]>): number[] {
  const weights = events.map(e => {
    const baseWeight = {
      'fresh': 1.0,
      'dwell_5s': 0.5,
      'dwell_30s': 1.0,
      'dwell_60s': 2.0,
      'reply': 3.0,
      'share': 2.5,
      'bookmark': 1.5,
      'click': 0.3,
    }[e.type] || 0.1;

    // 時間減衰: 24時間で半減
    const hoursAgo = (Date.now() - e.timestamp) / 3600000;
    const timeWeight = Math.pow(0.5, hoursAgo / 24);

    return baseWeight * timeWeight;
  });
  // ... weighted average
}
```

---

## Phase 4: インフラ改善（優先度: ★★☆☆☆）

### 4.1 マテリアライズドビュー (事前計算)

**Twitter参考**: Timelines Aggregation Framework (Scalding batch processing)

**提案**: 推薦スコアを事前計算してキャッシュ:

```sql
-- ランキング用マテリアライズドビュー (15分ごとに更新)
CREATE TABLE trending_cache AS
SELECT id,
  ((fresh_count * 2.0 + reply_count * 3.0 + impressions * 0.1 + 1.0) /
   POWER(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 + 2, 1.5)) as score
FROM posts
WHERE status = 'published' AND hidden = 0 AND parent_id IS NULL
ORDER BY score DESC;

-- KVキャッシュ戦略
async function getCachedRecommendations(userId: string, type: string) {
  const cacheKey = `rec:${type}:${userId}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const results = await computeRecommendations(userId);
  await c.env.CACHE.put(cacheKey, JSON.stringify(results), { expirationTtl: 120 });
  return results;
}
```

### 4.2 非同期埋め込み更新

**現状**: 埋め込み生成が手動バッチ

**提案**: Cloudflare Queues で非同期更新:

```typescript
// 投稿作成/編集時にキューに追加
await c.env.QUEUE.send({
  type: 'update_embedding',
  postId: post.id,
  text: post.text,
  hashtags: post.hashtags,
});

// Queue consumer で埋め込み生成
export default {
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { postId, text, hashtags } = msg.body;
      const embedding = await generateEmbedding(text, hashtags);
      await env.DB.prepare(
        'INSERT OR REPLACE INTO post_embeddings (post_id, embedding) VALUES (?, ?)'
      ).bind(postId, JSON.stringify(embedding)).run();
    }
  }
};
```

### 4.3 ハイブリッドD1+Vectorize戦略

**現状**: Vectorize が使えない場合に D1 フォールバック（1000件制限）

**提案**: 多層キャッシュ:

```
Vectorize (ANN, 上位100件)
  → 失敗: KV キャッシュ (直近の人気投稿の埋め込み, 最大10000件)
    → 失敗: D1 post_embeddings (直近1000件)
      → 失敗: エンゲージメントベースフォールバック
```

---

## Phase 5: 長期的ロードマップ（優先度: ★☆☆☆☆）

### 5.1 Light Ranker の導入

**Twitter参考**: DeepBird (TensorFlow on Earlybird)

**Flaxia実装案**: Workers AI または外部APIで軽量モデルをホスト:

```typescript
// Workers AI (Cloudflare) でランキング
input_features = [
  postEmbedding,          // ベクトル埋め込み
  userEmbedding,          // ユーザー興味ベクトル
  authorQuality,          // 著者品質スコア
  hoursSinceCreation,     // 経過時間
  engagementSignals,      // Fresh/Reply/Impression
  contentType,            // swf/payload/text
  hasMedia,               // メディア有無
  similarityToHistory,    // 過去エンゲージメントとの類似度
];

const response = await c.env.AI.run('@cf/intel/ranking-model', {
  features: input_features,
});
```

### 5.2 グラフベース推薦 (簡易GraphJet)

**Twitter参考**: GraphJet (User-Tweet Entity Graph)

**Flaxia実装案**: D1のグラフクエリで2-hop推薦:

```sql
-- "この投稿にFreshしたユーザーが他にFreshした投稿" (協調フィルタリング)
SELECT p.*, COUNT(*) as co_occurrence
FROM posts p
JOIN freshs f1 ON f1.post_id = ?  -- 対象投稿
JOIN freshs f2 ON f2.user_id = f1.user_id AND f2.post_id = p.id
WHERE p.id != ?
GROUP BY p.id
ORDER BY co_occurrence DESC
LIMIT 20;
```

### 5.3 A/Bテスト基盤

**最小構成**:

```typescript
// シンプルなA/Bテスト
const EXPERIMENTS = {
  trending_formula: {
    buckets: ['v1', 'v2', 'v3'],
    // v1: 現行 (index 1.5), v2: 正確なPOWER, v3: 別の減衰関数
  },
  hybrid_weight: {
    buckets: ['70_30', '50_50', '30_70'],
    // vecSim : engNorm の比率
  },
};

function getExperiment(userId: string, experiment: string): string {
  const hash = simpleHash(`${userId}:${experiment}`);
  const config = EXPERIMENTS[experiment];
  return config.buckets[hash % config.buckets.length];
}

// 結果をログ
async function logExperimentResult(userId, experiment, bucket, metrics) {
  await env.DB.prepare(`
    INSERT INTO experiment_logs (user_id, experiment, bucket, impression_count, engagement_count, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).bind(userId, experiment, bucket, metrics.impressions, metrics.engagements).run();
}
```

---

## 6. 実装優先順位マトリックス

| Phase | 施策 | 難易度 | 効果 | 緊急度 | 優先度 |
|-------|------|--------|------|--------|--------|
| 0.1 | トレンド指数修正 | 低 | 中 | 高 | ★★★★★ |
| 0.2 | engagement_hotness更新 | 低 | 中 | 高 | ★★★★★ |
| 0.3 | 未ログインフォールバック | 低 | 中 | 中 | ★★★★☆ |
| 0.4 | カーソル安定化 | 低 | 低 | 中 | ★★★☆☆ |
| 1.1 | 投稿品質スコア | 中 | 中 | 中 | ★★★★☆ |
| 1.2 | 著者品質スコア | 中 | 中 | 中 | ★★★★☆ |
| 1.3 | コンテンツタイプ別重み | 低 | 中 | 中 | ★★★★☆ |
| 1.4 | 暗黙的シグナル収集 | 中 | 高 | 低 | ★★★☆☆ |
| 2.1 | 多相候補生成 | 中 | 高 | 低 | ★★★☆☆ |
| 2.2 | ε-greedy探索 | 低 | 中 | 低 | ★★☆☆☆ |
| 2.3 | Negativeフィードバック | 中 | 中 | 中 | ★★★☆☆ |
| 2.4 | コンテンツ別時間減衰 | 低 | 中 | 低 | ★★☆☆☆ |
| 3.1 | タグベースコミュニティ | 中 | 低 | 低 | ★★☆☆☆ |
| 3.2 | 興味ベクトル進化 | 中 | 中 | 低 | ★★☆☆☆ |
| 4.1 | 事前計算キャッシュ | 中 | 高 | 低 | ★★☆☆☆ |
| 4.2 | 非同期埋め込み更新 | 高 | 高 | 低 | ★★☆☆☆ |
| 4.3 | ハイブリッド検索戦略 | 中 | 中 | 低 | ★☆☆☆☆ |
| 5.1 | Light Ranker | 高 | 高 | 低 | ★☆☆☆☆ |
| 5.2 | グラフベース推薦 | 高 | 中 | 低 | ★☆☆☆☆ |
| 5.3 | A/Bテスト基盤 | 中 | 中 | 低 | ★☆☆☆☆ |

---

## 7. Twitterから学ぶべきではないこと

Flaxiaのアーキテクチャと哲学に合わないTwitterのアプローチ:

### 7.1 複雑性をそのまま取り入れない

- Twitterの6000特徴量はFlaxiaには過剰
- 3-10程度の高品質特徴量で十分に良い結果が出せる
- シンプルさがFlaxiaの最大の強み

### 7.2 ブラックボックスNNを避ける

- MaskNetのような解釈不可能なモデルはFlaxiaの透明性を損なう
- 線形モデル + 決定木程度の説明可能なMLにとどめる
- Flaxiaの「Sandboxで動くアプリ」というユニークな価値提案を忘れない

### 7.3 エンゲージメント最適化の罠

- Twitterはエンゲージメント最適化が極端コンテンツを促進
- Flaxiaは「質の高いゲーム/アプリの発見」をKPIにすべき
- エンゲージメントだけでなく、ユーザー満足度や作成者の収益も考慮

### 7.4 バッチ処理の完全採用を避ける

- TwitterのScalding/Hadoopバッチ処理はFlaxiaには重すぎる
- Edge computing に最適化された軽量アプローチを維持
- リアルタイム性を損なわない設計を優先

---

## 8. Flaxiaに固有の推薦価値提案

Twitterと差別化できるFlaxia独自の推薦要素:

### 8.1 プレイアブルコンテンツの推薦

```
ゲーム/アプリ投稿の推薦アルゴリズムはテキスト投稿と根本的に異なるべき:
  - プレイ時間 (dwell) が最重要指標
  - リプレイ可能性 (再訪率) が品質指標
  - ソーシャル要素 (マルチプレイ) がリテンション指標
  - SWF/HTML5/ネイティブで質評価が異なる
```

### 8.2 クリエイターエコノミー対応

```
- 新規クリエイターの投稿を優遇 (Boost)
- 収益化可能な投稿を優先表示
- クリエイターとファンをつなぐ推薦
- Sandboxアプリの質を評価する仕組み
```

### 8.3 分散型/ActivityPub連携

```
- 連合インスタンス間での推薦
- インスタンスローカル vs グローバルバランス
- NodeInfoに基づくインスタンス品質評価
- モデレーションポリシーの違いを考慮
```

---

## 9. まとめ

FlaxiaがTwitterの推薦アルゴリズムから学ぶべき核心:

1. **多相候補生成**が品質の鍵: 単一SQLではなく複数の視点から候補を集める
2. **パーソナライズの第一歩はシグナル収集**: 暗黙的シグナルを集める仕組みが最優先
3. **フィルタリングが品質を決める**: 入り口を広く、出口を厳しく
4. **シンプルさを武器に**: Flaxiaの透明性・解釈可能性はTwitterに対する最大の優位性
5. **Sandboxが最強の差別化要因**: プレイアブルコンテンツの推薦に集中すべき
6. **段階的に進化**: Phase 0→5 の順で、効果の高いものから実装
