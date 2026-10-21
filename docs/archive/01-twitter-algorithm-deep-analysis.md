# Twitter推薦アルゴリズム徹底解剖

本ドキュメントは X (旧Twitter) の Recommendation Algorithm リポジトリ (`the-algorithm`) の全コードを解析し、そのアルゴリズム・アーキテクチャ・実装詳細を網羅的に解説する。

---

## 1. システムアーキテクチャ概要

Xの推薦システムは、**Candidate Generation → Feature Hydration → Scoring & Ranking → Filtering & Mixing** の4段階パイプラインで構成される。

```
User Request (Home Timeline)
    │
    ▼
┌──────────────────────────────────────────────────────┐
│ 1. Candidate Generation                               │
│   ├── In-Network: Search Index (Earlybird) ~50%      │
│   └── Out-of-Network: Tweet Mixer ~50%               │
│       ├── SimClusters ANN (コミュニティベース)        │
│       ├── TwHIN ANN (ナレッジグラフ埋め込み)          │
│       ├── UTEG (User-Tweet Entity Graph, GraphJet)   │
│       ├── FRS (Follow Recommendations)                │
│       └── CR-Mixer (Candidate Retrieval Mixer)        │
└──────────────┬───────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│ 2. Feature Hydration (~6000 features)                 │
│   ├── RealGraph (ユーザー間インタラクション確率)      │
│   ├── SimClusters Embeddings                          │
│   ├── TwHIN Embeddings                                │
│   ├── TweepCred (PageRank ベースの評判スコア)         │
│   ├── 過去のインプレッション・エンゲージメント履歴     │
│   ├── 著者の特徴量 (フォロワー数、ツイート頻度等)     │
│   └── 言語・地域・トピック情報                        │
└──────────────┬───────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│ 3. Scoring & Ranking                                  │
│   ├── Light Ranker (Earlybird内蔵、TensorFlow)        │
│   └── Heavy Ranker (MaskNet ベースのNN)               │
└──────────────┬───────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│ 4. Filtering & Mixing                                 │
│   ├── 著者ダイバーシティ                               │
│   ├── コンテンツバランス                               │
│   ├── Feedback Fatigue (同じ著者/トピックを避ける)    │
│   ├── 重複排除                                         │
│   ├── Visibility Filtering (法務/spam/NSFW等)         │
│   └── 広告・WTFモジュール・プロンプトの挿入           │
└──────────────────────────────────────────────────────┘
               │
               ▼
          For You Timeline (40~80 posts)
```

---

## 2. SimClusters: コミュニティベース埋め込み表現 (KDD'2020)

**Path**: `src/scala/com/twitter/simclusters_v2/`
**論文**: SimClusters: Community-based Representations for Heterogeneous Recommendations at Twitter (KDD'2020)

SimClustersはXの推薦システムの中核をなす、**疎なコミュニティベースの埋め込み表現**である。

### 2.1 アルゴリズムの数学的基礎

#### 2.1.1 二部グラフとしてのフォロー関係

フォロー関係を **Consumer × Producer** の二部グラフと見なす。Consumer $c$ が Producer $p$ をフォローしているとき、行列 $A \in \mathbb{R}^{m \times n}$ の要素 $A_{c,p} = 1$ とする（$m$ = Consumer数, $n$ = Producer数）。

#### 2.1.2 Producer-Producer類似度

$$
\text{sim}(p_i, p_j) = \cos(A_{:,p_i}, A_{:,p_j}) = \frac{A_{:,p_i} \cdot A_{:,p_j}}{\|A_{:,p_i}\| \cdot \|A_{:,p_j}\|}
$$

つまり、「Producer $p_i$ をフォローしているConsumerのベクトル」と「Producer $p_j$ をフォローしているConsumerのベクトル」のコサイン類似度。

**実装**: `CosineSimilarityUtil.dotProduct()` (`src/scala/com/twitter/simclusters_v2/common/CosineSimilarityUtil.scala:203`)

```scala
def dotProduct[T](v1: Map[T, Double], v2: Map[T, Double]): Double = {
  val comparer = v1.size - v2.size
  val smaller = if (comparer > 0) v2 else v1
  val bigger = if (comparer > 0) v1 else v2
  smaller.foldLeft(0.0) {
    case (sum, (id, value)) => sum + bigger.getOrElse(id, 0.0) * value
  }
}
```

パフォーマンス最適化のため、ソート済み配列版も存在する: `dotProductForSortedClusterAndScores()` (同ファイル224行) - 双方向ポインター走査で $O(n_1 + n_2)$。

#### 2.1.3 Louvainコミュニティ検出 (KnownFor)

Producer-Producer類似度グラフに **Louvainアルゴリズム**（Metropolis-Hastingsサンプリングベース）を適用し、$k$個のコミュニティを検出する。

**実装**: `src/scala/com/twitter/simclusters_v2/common/clustering/LouvainClusteringMethod.scala`

プロデューサー $p$ のコミュニティ所属スコアを行列 $V \in \mathbb{R}^{n \times k}$ として表現。各プロデューサーは最大1つのコミュニティに所属（最大疎）。

本番環境では **2000万プロデューサー、14万5000コミュニティ** をカバー。

#### 2.1.4 Consumer埋め込み (User InterestedIn)

$$
U = A \times V
$$

ただし $U \in \mathbb{R}^{m \times k}$ はConsumerの興味行列。Consumer $c$ のコミュニティ $i$ に対する興味スコア:

$$
U_{c,i} = \sum_{p: A_{c,p} > 0} A_{c,p} \cdot V_{p,i}
$$

ConsumerがフォローしているProducer群が「Known For」コミュニティの加重和で表現される。

**実装**: `InterestedInFromKnownFor.scala`

```scala
// InterestedIn = FollowGraph × KnownFor (行列積)
val interestedIn = followGraph.multiply(knownForMatrix)
```

#### 2.1.5 Producer埋め込み ($\tilde{V}$)

各Producerのフォロワー集合と各コミュニティの InterestedIn ベクトルとのコサイン類似度:

$$
\tilde{V}_{p,i} = \cos(A_{:,p}, U_{:,i})
$$

つまり「このProducerのフォロワーは、コミュニティiにどの程度興味があるか」。

### 2.2 ツイート埋め込み

ツイート $t$ の埋め込みは、そのツイートをFavしたユーザーの InterestedIn ベクトルの累積和:

$$
E_t = \sum_{u \in \text{FavUsers}(t)} U_u
$$

リアルタイム更新（Heron/Summingbird Storm Job）。

### 2.3 SimClusters ANN オンライン候補生成

**Path**: `simclusters-ann/server/src/main/scala/com/twitter/simclustersann/candidate_source/`

Approximate Nearest Neighbor探索による候補生成。6ステップ:

1. **Source Embedding取得**: Consumerの InterestedIn 埋め込みまたはProducer埋め込みを取得
2. **クラスター選択**: スコア上位Nクラスターを選択 (`maxScanClusters = 50`)
3. **Top Tweet取得**: 各クラスターのTopKツイートを取得 (`maxTopTweetsPerCluster = 200`)
4. **近似的コサイン類似度計算**: Source埋め込みと各候補ツイートのスコアの重み付き和

```scala
// SimClustersANNCandidateSource.scala:134-153
// sourceClusterScore = sourceEmbedding[clusterId]
// tweetScore = clusterTweetCandidatesStore[clusterId][tweetId]
candidateScore += tweetScore * sourceClusterScore
```

5. **部分正規化**: 人気バイアス除去のためL2正規化

```scala
val processedScore = score / sourceEmbedding.l2norm / math.sqrt(normalizationSum)
```

6. **Heavy Ranking**（オプション）: 埋め込みペアの類似度（コサイン・ドット積・Jaccard等）でリランク

### 2.4 埋め込みタイプ一覧

約20種類の埋め込みタイプが存在:

| EmbeddingType | 説明 | 用途 |
|---------------|------|------|
| `FavBasedProducer` | FavベースのProducer埋め込み | Producer起点の推薦 |
| `LogFavBasedTweet` | LogFavベースのツイート埋め込み | ツイート類似度検索 |
| `LogFavBasedUserInterestedInFromAPE` | APE由来のUser興味 | Consumer起点の推薦 |
| `FollowBasedUserInterestedInFromAPE` | フォローベース興味 | 新規向け |
| `FavTfgTopic` | Topic Follow Graph | トピック推薦 |
| `LogFavBasedKgoApeTopic` | KGO APEトピック | トピック推薦 |
| `UserNextInterestedIn` | 次の興味予測 | 探索促進 |

---

## 3. TweepCred: PageRankベースのユーザー信頼度

**Path**: `src/scala/com/twitter/graph/batch/job/tweepcred/`

各ユーザーの「信用度」を weighted PageRank で計算するバッチジョブ。

### 3.1 アルゴリズム

**定義**:
- $N$: 全ノード数
- $\text{PR}(N_i)$: ノード$i$のPageRank
- $d(N_j)$: $N_j$の出次数
- $\alpha$: ランダムジャンプ確率 (デフォルト0.1)

**非重み付き**:

$$
\text{PR}_{\text{next}}(N_i) = \sum_{j \to i} \frac{\text{PR}(N_j)}{d(N_j)}
$$

**重み付き** ($\text{tw}(N_j)$ = $N_j$の総出重み):

$$
\text{PR}_{\text{next}}(N_i) = \sum_{j \to i} \frac{\text{PR}(N_j) \cdot w(N_j, N_i)}{\text{tw}(N_j)}
$$

**最終スコア**:

$$
\text{deadPR} = \frac{1 - \sum_i \text{PR}_{\text{next}}(N_i)}{N}
$$

$$
\text{randomPR}(N_i) = \text{massPrior}(N_i) \times \alpha + \text{deadPR} \times (1-\alpha)
$$

$$
\text{PR}_{\text{output}}(N_i) = \text{randomPR}(N_i) + \text{PR}_{\text{next}}(N_i) \times (1-\alpha)
$$

**実装**: `WeightedPageRank.scala`

```scala
// WeightedPageRank.scala:163-234
// 1. 各ノードのPageRankを分散
val pagerankNext = nodeJoined.flatMapTo(...) {
  if (WEIGHTED) {
    val total: Double = args._2.sum
    (args._1 zip args._2).map { (id, weight) =>
      (id, args._3 * weight / total)
    }
  } else {
    val dist: Double = args._3 / args._1.length
    args._1.map(id => (id, dist))
  }
}

// 2. ランダムジャンプ + デッドPR
val randomPagerank = nodeJoined.crossWithTiny(deadPagerank).map {
  (src_id, mass_prior, deadMass, mass_input) =>
    (src_id, mass_prior * ALPHA + deadMass * (1 - ALPHA), mass_input)
}

// 3. PageRankスケーリング + 合算
(pagerankNextScaled ++ randomPagerank).groupBy('src_id) { .sum }
```

### 3.2 収束条件

- 最大20イテレーション
- 収束閾値: totalDiff < 0.001
- 各イテレーション後に収束判定し、未収束なら次のイテレーションを起動

---

## 4. RealGraph / Interaction Graph: ユーザー間インタラクション予測

**Path**: `src/scala/com/twitter/interaction_graph/`

ユーザー $u$ がユーザー $v$ とインタラクションする確率を予測するMLモデル。

### 4.1 特徴量エンジニアリング

多種多様なインタラクションを時系列で集約:

| 集約タイプ | 説明 | 実装パス |
|-----------|------|---------|
| `agg_direct_interactions` | Fav, Reply, Retweet 等 | `scio/agg_direct_interactions/` |
| `agg_client_event_logs` | クライアントイベントログ | `scio/agg_client_event_logs/` |
| `agg_flock` | フォローグラフ | `scio/agg_flock/` |
| `agg_negative` | ミュート・ブロック等のネガティブ | `scio/agg_negative/` |
| `agg_notifications` | 通知関連 | `scio/agg_notifications/` |
| `agg_address_book` | アドレス帳 | `scio/agg_address_book/` |
| `agg_all` | 全ロールアップ | `scio/agg_all/` |

### 4.2 MLモデル

Gradient Boosted Tree ベースの2値分類器で「ユーザーuがユーザーvとインタラクションするか」を予測。

**Path**: `bqe/training/` (訓練), `bqe/scoring/` (スコアリング)

---

## 5. CR-Mixer: Candidate Retrieval Mixer

**Path**: `cr-mixer/`

CR-Mixerは候補生成の一元管理サービス。パイプライン:

```
Source Signal → Candidate Generation → Filtering → Ranking
```

### 5.1 35の類似度エンジン

全エンジン一覧 (`cr-mixer/server/src/main/scala/com/twitter/cr_mixer/similarity_engine/`):

| エンジン | ベース技術 | 説明 |
|---------|-----------|------|
| `SimClustersANNSimilarityEngine` | SimClusters疎埋め込み | コミュニティベースANN |
| `TwhinCollabFilterSimilarityEngine` | TwHIN協調フィルタリング | 高密度埋め込み |
| `ConsumerEmbeddingBasedTwHINSimilarityEngine` | TwHIN + Consumer埋め込み | Consumer起点 |
| `ConsumerEmbeddingBasedTwoTowerSimilarityEngine` | Two-Towerモデル | 別エンコーダー方式 |
| `ConsumerEmbeddingBasedTripSimilarityEngine` | Trip (3塔モデル) | Consumer-Tweet-Entity |
| `DiffusionBasedSimilarityEngine` | グラフ拡散 | ソーシャルグラフ伝播 |
| `HnswANNSimilarityEngine` | HNSW (Hierarchical Navigable Small World) | 高密度ベクトルANN |
| `EarlybirdTensorflowBasedSimilarityEngine` | TFモデル + 検索インデックス | LightRanker統合 |
| `EarlybirdModelBasedSimilarityEngine` | Earlybirdモデル | レガシー |
| `EarlybirdRecencyBasedSimilarityEngine` | 新しさベース | リアルタイム |
| `UserTweetEntityGraphSimilarityEngine` | GraphJet | 実時間グラフ探索 |
| `ProducerBasedUnifiedSimilarityEngine` | 統合Producer | 複数ソース統合 |
| `TweetBasedUnifiedSimilarityEngine` | 統合Tweet | 複数ソース統合 |
| `TweetBasedQigSimilarityEngine` | QIG (Quality Index Graph) | 品質指標 |
| `TweetBasedUserAdGraphSimilarityEngine` | Ad Graph | 広告関連 |
| `TweetBasedUserTweetGraphSimilarityEngine` | UTG | User-Tweet Graph |
| `TweetBasedUserVideoGraphSimilarityEngine` | UVG | User-Video Graph |
| `ConsumersBasedUserAdGraphSimilarityEngine` | 広告グラフConsumer基点 | 広告 |
| `ConsumersBasedUserVideoGraphSimilarityEngine` | ビデオグラフConsumer基点 | 動画 |
| `ProducerBasedUserAdGraphSimilarityEngine` | 広告グラフProducer基点 | 広告 |
| `ProducerBasedUserTweetGraphSimilarityEngine` | UTG Producer基点 | ツイート |
| `ProducerBasedUnifiedSimilarityEngine` | 統合Producer | 全ソース |
| `CertoTopicTweetSimilarityEngine` | Certoトピック | Spam対策済トピック |
| `SkitTopicTweetSimilarityEngine` | Skitトピック | 高精度トピック |
| `SkitHighPrecisionTopicTweetSimilarityEngine` | Skit高精度 | 厳選トピック |
| `ModelBasedANNStore` | モデルベースANN | 汎用 |
| `StandardSimilarityEngine` / `LookupSimilarityEngine` | 汎用ラッパー | |

### 5.2 ブレンディング戦略

**Path**: `cr-mixer/blender/`

- `InterleaveBlending`: 各ソースから交互に候補を取得
- `WeightedBlending`: ソース別重み付け
- `ContentSignalBlending`: コンテンツシグナルベース
- `SourceTypeBackfillBlending`: ソースタイプ別バックフィル

### 5.3 フィルター

**Path**: `cr-mixer/filter/`

- `ReplyFilter`: リプライ除外
- `RetweetFilter`: リツイート除外
- `TweetAgeFilter`: 古さでフィルター
- `VideoFilter`: 動画のみ/除外
- `HealthFilter`: 品質フィルター
- `ImpressedListFilter`: 既読除外

---

## 6. Tweet Mixer: アウトオブネットワーク候補生成

**Path**: `tweet-mixer/`

Twitterではタイムラインの約半分が **Out-of-Network**（フォロー外のアカウント）からのツイート。

22の候補ソース:

1. `simclusters_ann/` - SimClusters ANN
2. `twhin_ann/` - TwHIN ANN
3. `text_embedding_ann/` - テキスト埋め込みANN
4. `content_embedding_ann/` - コンテンツ埋め込みANN
5. `ndr_ann/` - Negative Discovery Rate ANN
6. `UTG/` - User-Tweet Graph
7. `UVG/` - User-Video Graph
8. `earlybird_realtime_cg/` - Earlybirdリアルタイム候補生成
9. `engaged_users/` - エンゲージメントユーザー
10. `topic_tweets/` - トピックツイート
11. `popular_topic_tweets/` - 人気トピックツイート
12. `popular_grok_topic_tweets/` - Grok人気トピック
13. `trends/` - トレンド
14. `events/` - イベント
15. `evergreen_videos/` - エバーグリーン動画
16. `qig_service/` - Quality Index Graph
17. `uss_service/` - User Signal Service
18. `curated_user_tls_per_language/` - 言語別キュレーションユーザー

---

## 7. Home Mixer: パイプライン統合

**Path**: `home-mixer/`

Product Mixer フレームワーク上に構築された、For You タイムライン構築の要。

### 7.1 パイプライン構成

```scala
// For You パイプライン (44のコンポーネント)
// 主なCandidate Pipeline:
- ForYouScoredTweets          // スコア済みツイート
- ForYouConversationService   // 会話スレッド
- ForYouBookmarks             // ブックマーク
- ForYouPinnedTweets          // 固定ツイート
- ForYouWhoToFollow           // フォロー推奨
- ForYouAds                   // 広告
- ForYouRelevancePrompt       // 関連性プロンプト
- ForYouCommunitiesToJoin     // コミュニティ参加勧誘
- ForYouKeywordTrends         // キーワードトレンド
- ForYouStories               // ストーリー
- ForYouVideoCarousel         // 動画カルーセル
- ForYouTuneFeed              // Tune Feed
```

### 7.2 109の特徴量ハイドレーター

`home-mixer/server/.../functional_component/feature_hydrator/` には109の特徴量ハイドレーターが存在。

**カテゴリ別:**

| カテゴリ | 例 | 数 |
|---------|---|----|
| RealGraph系 | `RealGraphQueryFeatureHydrator`, `RealGraphInNetworkScoresQueryFeatureHydrator`, `RealTimeEntityRealGraphQueryFeatureHydrator` | 10+ |
| SimClusters系 | `SimClustersUserSparseEmbeddingsQueryFeatureHydrator`, `SimClustersEngagementSimilarityFeatureHydrator` | 5+ |
| TwHIN系 | `TwhinUserEngagementQueryFeatureHydrator`, `TwhinUserFollowQueryFeatureHydrator`, `TwhinTweetFeatureHydrator` | 10+ |
| ユーザー履歴 | `UserActionsQueryFeatureHydrator`, `UserHistoryTransformerEmbeddingQueryFeatureHydrator` | 5+ |
| 著者情報 | `AuthorFeatureHydrator`, `GizmoduckAuthorFeatureHydrator`, `AuthorLargeEmbeddingsFeatureHydrator` | 5+ |
| ツイート情報 | `TweetMetaDataFeatureHydrator`, `TweetLanguageFeatureHydrator`, `TweetTimeFeatureHydrator` | 5+ |
| メディア | `MediaClusterIdFeatureHydrator`, `ClipEmbeddingFeatureHydrator`, `MultiModalEmbeddingsFeatureHydrator` | 5+ |
| オフライン集約 | `offline_aggregates/` | 多数 |
| リアルタイム集約 | `real_time_aggregates/` | 多数 |

### 7.3 36のフィルター

`home-mixer/server/.../functional_component/filter/`:

- `AuthorDedupFilter` - 同一著者の過剰表示防止
- `FeedbackFatigueFilter` - フィードバック疲れ防止
- `PreviouslySeenTweetsFilter` - 既視ツイート除去
- `PreviouslyServedTweetsFilter` - 既提供ツイート除去
- `RetweetFilter` / `ReplyFilter` - リツイート/リプライ制御
- `GrokGoreFilter`, `GrokNsfwFilter`, `GrokSpamFilter`, `GrokViolentFilter` - Grok品質フィルター
- `CountryFilter`, `RegionFilter`, `LocationFilter` - 地域フィルター
- `MaxVideoDurationFilter`, `MinVideoDurationFilter` - 動画長フィルター
- `ClusterBasedDedupFilter` - クラスター重複除去
- `MediaDeduplicationFilter` - メディア重複除去
- `QuoteDeduplicationFilter` - 引用重複除去

---

## 8. Follow Recommendations Service (FRS)

**Path**: `follow-recommendations-service/`

Who-to-Follow 推薦サービス。

### 8.1 17の候補ソース

| ソース | アルゴリズム | 説明 |
|-------|------------|------|
| `sims/` | コサイン類似度 | 類似ユーザー |
| `sims_expansion/` | 類似ユーザー拡張 | 2-hop拡張 |
| `real_graph/` | GBT分類器 | 実グラフ予測 |
| `user_user_graph/` | GraphJet | User-Userグラフ |
| `stp/` | Strong Ties | 強いつながり予測 |
| `salsa/` | SALSA | ランダムウォーク分散 |
| `two_hop_random_walk/` | 2-hop RW | 2ホップランダムウォーク |
| `triangular_loops/` | 三角ループ | 三者閉路 |
| `recent_engagement/` | 最近の関与 | Recency重視 |
| `socialgraph/` | ソーシャルグラフ | 直接フォロー |
| `addressbook/` | アドレス帳 | 電話帳マッチ |
| `geo/` | 地理位置情報 | 地理的近接 |
| `ppmi_locale_follow/` | PPMI | 言語特化 |
| `top_organic_follows_accounts/` | 人気アカウント | オーガニック |
| `crowd_search_accounts/` | クラウドサーチ | 群衆検索 |
| `promoted_accounts/` | 広告主 | プロモーション |

### 8.2 ランキング戦略

- `ml_ranker/` - MLモデルによるランキング
- `interleave_ranker/` - インタリーブ
- `weighted_candidate_source_ranker/` - 重み付き
- `fatigue_ranker/` - 疲労考慮
- `first_n_ranker/` - TopN

---

## 9. ランキングモデル

### 9.1 Light Ranker (Earlybird)

**Path**: `src/python/twitter/deepbird/projects/timelines/scripts/models/earlybird/`

検索インデックス内で動作する軽量モデル。TensorFlowで実装。

特徴: 数百の特徴量, ミリ秒単位の推論, 全ツイートの一次フィルタリングに使用。

### 9.2 Heavy Ranker (外部リポジトリ)

**Path**: `the-algorithm-ml/projects/home/recap/`

MaskNet ベースのディープニューラルネットワーク。数千の特徴量を入力とする本格ランキングモデル。

### 9.3 Pushservice ランキング

**Path**: `pushservice/src/main/python/models/`

- **Light Ranking**: `deep_norm.py`, `model_pools_mlp.py`
- **Heavy Ranking**: マルチタスク学習（開封確率 + エンゲージメント確率を同時予測）

---

## 10. フィルタリングとVisibility

### 10.1 Visibility Library

**Path**: `visibilitylib/`

法的遵守、プロダクト品質、ユーザートラスト、収益保護のための4層フィルタリング:
- **Hard Filter**: 完全ブロック（違法コンテンツ等）
- **Visible Treatments**: ラベル表示（センシティブ等）
- **Coarse Downranking**: スコア減衰
- **Product Treatments**: UI上の措置

### 10.2 Trust & Safety Models

**Path**: `trust_and_safety_models/`

- `abusive_model.py`: 虐待的コンテンツ検出
- `nsfw_media.py`: NSFWメディア検出
- `nsfw_text.py`: NSFWテキスト検出
- `toxicity/`: 有害性モデル（訓練パイプライン含む）

---

## 11. データ基盤

### 11.1 Unified User Actions (UUA)

全ユーザーアクションのリアルタイムストリーム。Kafka + 各種アダプターで構成。

### 11.2 User Signal Service (USS)

明示的（Fav, Reply）および暗黙的（プロフィール閲覧, ツイートクリック）シグナルの一元管理。

### 11.3 Recography Feature Repository

約6000の特徴量を管理する特徴量ストア。

### 11.4 Timelines Aggregation Framework

バッチおよびリアルタイムで特徴量集約を行うフレームワーク:
- `metrics/`: Count, Sum, Latest, Max, TimedValue等のメトリクス
- `heron/`: ストリーミングトポロジ
- `scalding/`: バッチ処理

---

## 12. ML Serving Infrastructure

### 12.1 Navi (Rust)

**Path**: `navi/`

高パフォーマンスMLモデルサーバー。TensorFlow, PyTorch, ONNXモデルをサポート。

### 12.2 TWML (Legacy)

**Path**: `twml/`

TensorFlow v1ベースのレガシーMLフレームワーク（段階的廃止中）。

---

## 13. SimClustersの数式まとめ

| コンポーネント | 数式 | 説明 |
|-------------|------|------|
| Producer-Producer類似度 | $\cos(A_{:,p_i}, A_{:,p_j})$ | フォロワー分布のコサイン |
| KnownFor行列 | $V \in \mathbb{R}^{n \times k}$ | Louvainクラスタリング結果 |
| Consumer興味 | $U = A \times V$ | フォロー先のコミュニティの和 |
| Producer埋め込み | $\tilde{V}_{p,i} = \cos(A_{:,p}, U_{:,i})$ | フォロワーの興味分布との類似度 |
| ツイート埋め込み | $E_t = \sum_{u \in \text{Fav}(t)} U_u$ | Favユーザーの興味の和 |
| トピック埋め込み | $R_i = \cos(U, \text{Fav}_{topic})$ | トピック関連Favの集約 |
| ANNスコア | $\text{score} = \sum_c E_{source}[c] \cdot E_{tweet}[c]$ | 重み付きクラスタースコア |
| 正規化ANN | $\frac{E_{source} \cdot E_{tweet}}{\|E_{source}\| \cdot \sqrt{\sum E_{tweet}^2}}$ | 人気バイアス除去 |
