# Flaxia × Flaxia Crowd 統合 TODO

感情分析によるアンガーアテンションエコノミー低減のためのレコメンドアルゴリズム改善。

text-analyzer（`/packages/text-analyzer`）の感情分析パターンを参考に、非同期処理で感情スコアを収集し、**感情:表示（エンゲージメント） = 3:7** の重みでレコメンドスコアに統合する。

---

## P0: 基盤（最優先）

### P0-1: flaxia-crowd Worker の調整
- [ ] 感情分析用 AI 推論ワークロード（`text-classification`）が適切に動作することを確認
  - モデル: `Xenova/bert-base-multilingual-uncased-sentiment`（text-analyzer と同一）
  - ONNX 量子化（`q4f16`）でブラウザ負荷最小化
  - 5 段階ラベル出力: `very_negative / negative / neutral / positive / very_positive`
- [ ] flaxia-crowd Worker を同一 Cloudflare アカウントにデプロイ
  - `TaskQueue` / `NodeManager` Durable Object のバインディング設定
  - `CORS_ORIGINS` に `flaxia.app` を追加
  - `API_KEYS` に `fc_live_flaxia_*` キーを作成

### P0-2: flaxia へのパッケージ導入
- [ ] `@flaxia/sdk` を flaxia の依存に追加（npm インストール）
- [ ] `wrangler.toml` に DO バインディングを追加
  ```toml
  [[durable_objects.bindings]]
  name = "TASK_QUEUE"
  class_name = "TaskQueue"

  [[durable_objects.bindings]]
  name = "NODE_MANAGER"
  class_name = "NodeManager"

  [[migrations]]
  tag = "v1"
  new_classes = ["TaskQueue", "NodeManager"]
  ```
- [ ] 環境変数を設定
  - `CROWD_ORCHESTRATOR_URL` — flaxia-crowd Worker の URL
  - `CROWD_API_KEY` — 発行した API キー

### P0-3: ブラウザノード埋め込み（訪問者のブラウザを計算リソース化）
- [ ] `@flaxia/node` を導入
- [ ] `src/main.ts` で `initFlaxiaNode()` を初期化
  - 能力: `ai-inference` のみ
  - CPU 負荷制限: 0.15（デフォルト）
  - ConsentUI で同意取得（30 日間有効、Shadow DOM 表示）
- [ ] `public/_headers` に Cross-Origin 設定を追加（shared memory 用）
  ```text
  /*
    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp
  ```

---

## P1: データ基盤

### P1-1: DB スキーマ追加
- [ ] 新規 migration `0033_add_sentiment.sql` を作成
  ```sql
  ALTER TABLE posts ADD COLUMN sentiment_label TEXT;
  ALTER TABLE posts ADD COLUMN sentiment_score REAL;
  ALTER TABLE posts ADD COLUMN sentiment_processed_at TEXT;
  ```
  - `sentiment_label`: `very_negative / negative / neutral / positive / very_positive`
  - `sentiment_score`: 0.0（最もネガティブ）〜 1.0（最もポジティブ）、neutral = 0.5
  - `sentiment_processed_at`: ISO 8601、未処理なら NULL

### P1-2: 非同期感情分析パイプライン
- [ ] 投稿作成フックを実装（`functions/api/[[route]].ts`）
  - 投稿 commit 後、`FlaxiaClient.submit()` で感情分析タスクを非同期送信
  - text-analyzer の実装パターン（`packages/text-analyzer/src/main.ts:submitAnalysis()`）を参考
  ```typescript
  import { FlaxiaClient } from '@flaxia/sdk';

  const crowdClient = new FlaxiaClient({
    apiKey: CROWD_API_KEY,
    orchestratorUrl: CROWD_ORCHESTRATOR_URL,
  });

  // 新規投稿作成時に非同期でタスク送信
  async function analyzeSentiment(postId: string, text: string): Promise<void> {
    const task = await crowdClient.submit({
      workload: 'ai-inference',
      payload: {
        task: 'text-classification',
        model: 'Xenova/bert-base-multilingual-uncased-sentiment',
        inputs: text,
      },
    });
    // `waitForTask()` または WebSocket subscribe で結果を待ち受ける
    const result = await crowdClient.waitForTask(task.id);
    // 結果を DB に書き戻し
    // result.output → [{ label: 'positive', score: 0.92 }]
    const { label, score } = result.output[0];
    await c.env.DB.prepare(
      'UPDATE posts SET sentiment_label = ?, sentiment_score = ?, sentiment_processed_at = ? WHERE id = ?'
    ).bind(label, score, new Date().toISOString(), postId).run();
  }
  ```
- [ ] エラーハンドリング
  - タスク失敗 / タイムアウト時は `sentiment_processed_at` を NULL のままに
  - 再処理は行わない（フォールバック値を使用）
- [ ] 既存投稿のバックフィル
  - ノード空きリソースに応じて段階的に処理
  - `sentiment_processed_at IS NULL` の投稿を新しい順にバッチ処理

---

## P2: レコメンドアルゴリズム

### P2-1: スコア計算式（感情:表示 = 3:7）
- [ ] `/api/posts/recommended` のスコア計算を改善
  ```typescript
  // sentiment_factor: 0.0 (very_negative) 〜 1.0 (very_positive)
  // processed → sentiment_score をそのまま使用
  // NULL → 0.5 (neutral 扱い)
  const sentimentFactor = post.sentiment_score ?? 0.5;
  const sentimentWeight = 0.3;
  const engagementWeight = 0.7;

  const engagementScore =
    (post.fresh_count * 2 + post.impressions * 0.1 + 1) / (hoursSinceCreation + 2);

  const score = (sentimentFactor * sentimentWeight + engagementWeight) * engagementScore;
  ```
  - ネガティブ（0.0〜0.3）: スコアが 0.7〜0.79 倍に減少
  - ニュートラル（0.4〜0.6）: スコアが 0.82〜0.88 倍（ほぼ維持）
  - ポジティブ（0.7〜1.0）: スコアが 0.91〜1.0 倍（微増）
- [ ] スコア計算はアプリケーション層で実施（sentiment が非同期で後から入るため SQL 一発では算出不可）

### P2-2: Anger Attention 指標の可視化（管理画面）
- [ ] 管理画面タブに感情統計を追加（任意）
  - 全体の感情分布（very_negative 〜 very_positive）
  - ネガティブ投稿の平均インプレッション数推移
  - ポジティブ / ネガティブ比の時系列グラフ
  - ユーザー報告率の変化

---

## P3: UI/UX — 任意

### P3-1: タイムラインモード選択
- [ ] モード切り替え UI の検討（future work）
  - 「エンゲージメント優先」「バランス（3:7）」「ポジティブ優先」
  - デフォルトは「バランス」

### P3-2: 感情スコア表示
- [ ] ユーザーへの感情スコア表示の是非を検討
  - **懸念**: スコア表示が「この投稿は低評価されている」という印象を与える可能性
  - 現時点では非表示とし、アルゴリズムの内部パラメータとしてのみ使用

---

## 非機能要件・制約

- [ ] **ノード不在のフォールバック**:
  - クラウドノードがゼロの場合でも既存の chronological / engagement タイムラインが動作し続けること
  - `sentiment_score IS NULL` → `sentimentFactor = 0.5` で計算継続
- [ ] **遅延許容**:
  - 感情スコアは非同期で後から付与。投稿直後は未処理のまま表示され、スコア反映後に順位が変動する可能性がある
  - 許容レイテンシ目標: 投稿から 30 秒以内にスコア付与
- [ ] **プライバシー**:
  - 投稿テキストは公開情報だが、ノード間経路は暗号化（HTTPS / WSS）
  - 同意なしのブラウザリソース使用禁止（ConsentUI 必須）
- [ ] **text-analyzer 互換性**:
  - Vite の `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: require-corp` 設定が必要（shared memory buffer 用）
  - `public/_headers` または `vite.config.ts` で設定
