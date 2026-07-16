# Twitter vs Flaxia: 推薦アルゴリズム徹底比較

---

## 1. スケール比較

| 指標 | Twitter (the-algorithm) | Flaxia |
|------|----------------------|--------|
| 開発体制 | 数千人のエンジニア | 個人開発 |
| MAU | 3億+ | 個人利用レベル |
| 1日あたり投稿 | 5億+ | 個人利用レベル |
| レイテンシ要求 | サブ秒 | 秒単位可 |
| インフラ | 専用データセンター + GPUクラスタ | Cloudflare Workers (サーバーレス) |
| 推論基盤 | Navi (Rust) + カスタム推論サーバー | なし (SQL計算 + Vectorize) |
| コード規模 | ~100万行 (Scala/Java/Python/Rust) | ~3万行 (TypeScript) |

---

## 2. アーキテクチャ比較

### 2.1 全体アーキテクチャ

| 層 | Twitter | Flaxia |
|----|---------|--------|
| フロントエンド | ネイティブアプリ + Web (React) | Vanilla TypeScript SPA |
| API | Finagle/Thrift マイクロサービス | Hono (Cloudflare Functions) |
| DB | Manhattan (KV), MySQL, GCS | D1 (SQLite) |
| キャッシュ | MemCache, Redis | KV (Workers KV) |
| ストリーム処理 | Heron/Summingbird, Kafka | Cloudflare Queues |
| バッチ処理 | Scalding (Hadoop), BigQuery | なし (手動スクリプト) |
| ML基盤 | MLX, TensorFlow, PyTorch | Cloudflare Vectorize |
| グラフ処理 | GraphJet (JVM), カスタムScala | なし (SQL JOIN) |

### 2.2 推薦パイプライン

```
Twitter:
  Candidate Gen (50+ sources)
    → Feature Hydration (~6000 features)
      → Light Ranker → Heavy Ranker (MaskNet)
        → Filters (36+) → Mixing → Response

Flaxia:
  SQL Query (trending/recommended)
    → Vectorize (optional)
      → Hybrid scoring → Diversification → Response
```

---

## 3. アルゴリズム比較

### 3.1 候補生成

| 側面 | Twitter | Flaxia |
|------|---------|--------|
| In-Network | Search Index (Earlybird): フォローユーザーの投稿 ~50% | SQL: フォローユーザーの投稿を時系列 |
| Out-of-Network | 22 sources (SimClusters ANN, TwHIN, UTEG, etc.) ~50% | Vectorize ANN + エンゲージメントスコア |
| 候補ソース数 | 50+ | 3 (trending/recommended/similar) |
| 実時間性 | リアルタイムストリーミング | near-realtime (D1依存) |
| A/Bテスト | 大規模実験基盤 | なし |

### 3.2 埋め込み表現

| 側面 | Twitter (SimClusters) | Flaxia |
|------|----------------------|--------|
| タイプ | 疎ベクトル (~145k次元) | 密ベクトル (未確認次元数) |
| 学習方法 | Louvainコミュニティ検出 + フォローグラフ | 外部埋め込み生成（未確認） |
| スパース性 | 最大疎 (各要素がコミュニティ) | 密 (実数値ベクトル) |
| 解釈可能性 | 高い (コミュニティ単位で解釈可能) | 低い (密ベクトル) |
| 更新 | リアルタイム (Heron) | バッチ (手動) |
| スケール | 2000万Producer, 14.5万コミュニティ | 個人レベル |
| 論文 | KDD'2020 | なし |

### 3.3 ランキング

| 側面 | Twitter | Flaxia |
|------|---------|--------|
| 軽量ランカー | DeepBird (TensorFlow, Earlybird内蔵) | SQLスコアリング式 |
| 重量ランカー | MaskNet (ニューラルネット, 数千特徴量) | なし |
| 特徴量数 | ~6000 | 4 (fresh, reply, impressions, engagement_hotness) |
| パーソナライズ | 高度 (ユーザー埋め込み+履歴) | ベーシック (ベクトル類似度のみ) |
| モデル更新 | 継続的学習 | なし |

### 3.4 フィルタリング

| フィルター | Twitter | Flaxia |
|-----------|---------|--------|
| 著者重複 | AuthorDedupFilter | diversifyPosts (maxPerUser=3) |
| フィードバック疲れ | FeedbackFatigueFilter | なし |
| 既読除去 | PreviouslySeenTweetsFilter | なし |
| NSFW | GrokNsfwFilter, NSFWモデル | なし |
| Spam | GrokSpamFilter | なし |
| 暴力 | GrokViolentFilter, GrokGoreFilter | なし |
| 地域 | CountryFilter, RegionFilter | なし |
| 言語 | (言語別特徴量あり) | なし |
| ブロック | あり | あり (手動SQL) |
| コンテンツタイプ | Video/Reply/Retweet各フィルター | なし |
| 品質 | HealthFilter | なし |

### 3.5 ダイバーシティ

| 方策 | Twitter | Flaxia |
|------|---------|--------|
| 著者ダイバーシティ | AuthorDedupFilter + Content Balance | diversifyPosts (maxPerUser=3) |
| トピックダイバーシティ | CategoryDiversityRescoringFeatureHydrator | なし |
| メディア重複 | MediaDeduplicationFilter | なし |
| クラスター重複 | ClusterBasedDedupFilter | なし |

---

## 4. ユーザーシグナル比較

### 4.1 明示的シグナル

| シグナル | Twitter | Flaxia |
|---------|---------|--------|
| いいね/Fresh | Fav (Heavy Ranker 特徴量) | fresh_count (スコアに直接) |
| リツイート/Share | Retweet (特徴量) | share_count (DBに存在) |
| 返信 | Reply (特徴量) | reply_count (スコアに直接) |
| フォロー | Follow (グラフ構築に使用) | follow (フォローフィード用) |
| ブックマーク | Bookmark (特徴量) | bookmark_count (DBに存在) |
| ブロック/ミュート | Block/Mute (フィルター) | block (フィルター) |
| 報告 | Report (レビューパイプライン) | report (DBに存在) |
| NSFWマーク | NSFW (モデル学習) | なし |

### 4.2 暗黙的シグナル

| シグナル | Twitter | Flaxia |
|---------|---------|--------|
| インプレッション | Impression (特徴量 ~6000種) | impressions (スコアに直接) |
| クリック | Click (特徴量) | なし |
| プロフィール閲覧 | Profile Visit (USS) | なし |
| 滞在時間 | Dwell Time (特徴量) | ゲームのみ (dwell_ms) |
| スクロール | Scroll Depth (クライアント) | なし |
| 検索 | Search Query (特徴量) | なし |
| 通知エンゲージメント | Notification Click (特徴量) | なし |
| ビデオ視聴率 | Video Completion Rate (特徴量) | なし |

---

## 5. MLインフラ比較

| 側面 | Twitter | Flaxia |
|------|---------|--------|
| モデル形式 | TensorFlow, PyTorch, ONNX | なし (SQL計算) |
| 推論サーバー | Navi (Rust) | なし (Vectorize with embeddings) |
| 特徴量ストア | Recography (~6000 features) | D1テーブル |
| 実験基盤 | A/Bテスト + パラメータサーバー | なし |
| モデル管理 | バージョン管理あり | なし |
| オンライン学習 | Partial (継続的学習) | なし |

---

## 6. データ基盤比較

| 側面 | Twitter | Flaxia |
|------|---------|--------|
| ユーザーアクションストリーム | Unified User Actions (Kafka) | D1テーブル直接書き込み |
| リアルタイム集約 | Heron/Summingbird | なし (クエリ時に計算) |
| バッチ集約 | Scalding (Hadoop) / BigQuery | なし |
| 特徴量計算 | Timelines Aggregation Framework | SQL式で即時計算 |
| グラフ処理 | GraphJet (インメモリグラフ) | SQL JOIN |
| キャッシュ階層 | 多層 (MemCache, Manhattan, etc.) | KV (単層) |

---

## 7. アンチパターン/リスク比較

### 7.1 Twitter の課題

1. **ブラックボックス化**: 6000特徴量 + MaskNet で説明不可能
2. **フィルターバブル**: パーソナライズ強化による閉塞感
3. **エコーチェンバー**: コミュニティベース推薦の副作用
4. **インセンティブハック**: エンゲージメント最適化による極端コンテンツ促進
5. **新規参入障壁**: フォロワー数とTweepCredの累積優位

### 7.2 Flaxia の課題

1. **スパム脆弱性**: エンゲージメントファーミングに対して無防備
2. **コールドスタート**: 新規ユーザー/投稿の発見性が低い
3. **品質劣化**: 品質フィルター不在で低品質コンテンツが混入
4. **スケール限界**: D1の行数制限 + WorkersのCPU時間制限
5. **一貫性のないCursor**: score + created_atの複合カーソルで重複/欠落リスク
6. **リアルタイム性**: 埋め込み更新がバッチ処理のみ
7. **分析不在**: 推薦結果の評価指標がない

---

## 8. コード品質比較

| 側面 | Twitter | Flaxia |
|------|---------|--------|
| 型安全性 | Scala (強い型付け) | TypeScript strict mode |
| 並行処理 | Future (Finagle) | async/await |
| テスタビリティ | テストカバレッジあり | 基本的なAPIテストのみ |
| モジュール性 | 明確な関心分離 | monolithic [[route]].ts |
| ドキュメント | README各所 + 論文 | README + docs/ |
| CI/CD | 内部的 (Jenkins) | GitHub Actions |

---

## 9. 総合評価

| カテゴリ | Twitter | Flaxia | 差 |
|---------|---------|--------|---------|
| 推薦品質 | ★★★★★ | ★★☆☆☆ | Twitterが3段階優位 |
| パーソナライズ | ★★★★★ | ★★☆☆☆ | Twitterが3段階優位 |
| リアルタイム性 | ★★★★☆ | ★★★☆☆ | Twitterが1段階優位 |
| スケーラビリティ | ★★★★★ | ★★☆☆☆ | Twitterが3段階優位 |
| シンプルさ | ★★☆☆☆ | ★★★★★ | Flaxiaが3段階優位 |
| 解釈可能性 | ★★☆☆☆ | ★★★★☆ | Flaxiaが2段階優位 |
| メンテナンス性 | ★★☆☆☆ | ★★★★☆ | Flaxiaが2段階優位 |
| コスト効率 | ★☆☆☆☆ | ★★★★★ | Flaxiaが4段階優位 |
| 透明性 | ★★★★☆ | ★★★★★ | Flaxiaが1段階優位 |
| 革新性 | ★★★★☆ | ★★★★★ | Flaxiaが1段階優位 (Sandbox) |
