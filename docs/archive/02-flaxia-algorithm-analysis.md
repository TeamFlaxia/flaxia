# Flaxia 推薦アルゴリズム分析

本ドキュメントは Flaxia リポジトリの全コードを解析し、現状の推薦システム・アルゴリズムを網羅的に解説する。

---

## 1. Flaxia 概要

Flaxia は「投稿が生きて動くアプリケーション」を掲げる、Adobe Flash の精神的後継SNS。Cloudflare Workers エコシステム上で動作する完全サーバーレスアーキテクチャ。

### 1.1 アーキテクチャ

```
flaxia.app (Cloudflare Pages)
├── SPA (Vanilla TypeScript)
├── Hono API (Pages Functions)
└── D1 Database (SQLite)

sandbox.flaxia.app (Cloudflare Worker)
├── Sandbox Worker (Hono)
├── R2 Storage (コンテンツ)
└── CSP enforced iframe
```

### 1.2 技術スタック

| 層 | 技術 |
|----|------|
| フロントエンド | Vanilla TypeScript (No Framework) |
| API | Hono (Cloudflare Pages Functions) |
| DB | Cloudflare D1 (SQLiteベース) |
| ストレージ | Cloudflare R2 |
| ベクトル検索 | Cloudflare Vectorize |
| 非同期処理 | Cloudflare Queues |
| リアルタイム | Durable Objects (WebSocket/WebRTC) |
| ビルド | Vite + Biome |
| テスト | Node.js native test runner |

### 1.3 データベーススキーマ (推薦関連)

```sql
-- 投稿
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  text TEXT,
  fresh_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  engagement_hotness REAL DEFAULT 0,
  parent_id TEXT,
  root_id TEXT,
  depth INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  status TEXT DEFAULT 'published',
  created_at TEXT
);

-- イイね（Fresh）
CREATE TABLE freshs (
  user_id TEXT,
  post_id TEXT
);

-- ゲームプレイ時間
CREATE TABLE user_game_plays (
  user_id TEXT,
  post_id TEXT,
  dwell_ms INTEGER,
  created_at TEXT
);

-- 投稿埋め込みベクトル
CREATE TABLE post_embeddings (
  post_id TEXT PRIMARY KEY,
  embedding TEXT,  -- JSON配列
  created_at TEXT
);
```

---

## 2. 推薦アルゴリズム詳細

Flaxia には3つの主要な推薦エンドポイントが存在する。

### 2.1 トレンド投稿 (`GET /api/posts/trending`)

**Path**: `functions/api/[[route]].ts` (4467行目)

#### スコアリング式

```sql
score = (fresh_count * 2.0 + reply_count * 3.0 + impressions * 0.1 + 1.0)
      / ((hours_since_creation + 2.0) ^ 1.5)
```

数式表現:

$$
\text{score}(p) = \frac{2 \times \text{fresh}_p + 3 \times \text{reply}_p + 0.1 \times \text{impressions}_p + 1}{(t_{\text{now}} - t_{\text{created}} + 2)^{1.5}}
$$

ただし SQLite に `POW()` がないため、実際には:

```sql
score = numerator / ((hours + 2) * (hours + 2))
```

つまり $(h+2)^2$（指数1.5ではなく2）で減衰している。

#### 分析

| 要素 | 重み | 評価 |
|------|------|------|
| Fresh (イイね) | ×2.0 | 適切。エンゲージメントの中核指標 |
| Reply (返信) | ×3.0 | 高め。会話促進に有効 |
| Impressions (表示数) | ×0.1 | 低め。露出バイアスを抑える |
| +1 (スムージング) | 定数 | ゼロ除算・スパースネス対策 |
| 時間減衰 | $(h+2)^{1.5}$ | Reddit/HackerNewsスタイルの適切な減衰 |

#### 制約

- **7日以内**の投稿のみ対象
- **root投稿のみ**（`parent_id IS NULL`）
- **DB フルスキャン** (ORDER BY score DESC でインデックスが効かない可能性)
- **パーソナライズゼロ** - 全ユーザー同一結果

#### コード抜粋

```typescript
// trending endpoint - line 4467-4494
const query = `
  SELECT p.id, ..., u.display_name, ...,
    ((p.fresh_count * 2.0 + COALESCE(p.reply_count, 0) * 3.0
      + p.impressions * 0.1 + 1.0) /
    ((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0) *
    ((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0)) as score
  FROM posts p
  LEFT JOIN users u ON p.user_id = u.id
  WHERE p.status = 'published' AND p.hidden = 0
    AND p.parent_id IS NULL
    AND p.created_at > datetime('now', '-7 days')
  ORDER BY score DESC, p.created_at DESC
  LIMIT ?
`;
```

### 2.2 おすすめ投稿 (`GET /api/posts/recommended`)

**Path**: `functions/api/[[route]].ts` (4660行目)

Flaxia で最も高度な推薦アルゴリズム。**ベクトル類似度 + エンゲージメントのハイブリッド**。

#### 2.2.1 ユーザー興味ベクトル構築

```typescript
// 1. 直近50件のFresh投稿IDを取得
const freshRows = await c.env.DB.prepare(
  'SELECT f.post_id FROM freshs f JOIN posts p ON p.id = f.post_id WHERE f.user_id = ? ORDER BY p.created_at DESC LIMIT 50'
).bind(currentUserId).all<{ post_id: string }>();

// 2. 直近50件のゲームプレイ履歴 (5秒以上滞在)
const dwellRows = await c.env.DB.prepare(
  `SELECT post_id, dwell_ms FROM user_game_plays
   WHERE user_id = ? AND dwell_ms > 5000
   ORDER BY created_at DESC LIMIT 50`
).bind(currentUserId).all<{ post_id: string; dwell_ms: number }>();

// 3. 重み付きベクトル平均
// Fresh: 重み1.0, ゲーム: 重み min(dwell_ms/30000, 1.0)
interestVector = weightedAvg(allEmbeddings)
```

興味ベクトル $v_u$:

$$
v_u = \frac{\sum_{p \in \text{Fresh}(u)} E_p + \sum_{p \in \text{Dwell}(u)} \min(\frac{t_{\text{dwell}}}{30000}, 1.0) \cdot E_p}{|\text{Fresh}(u)| + |\text{Dwell}(u)|}
$$

#### 2.2.2 ベクトル検索 (Cloudflare Vectorize)

```typescript
const queryResult = await vectorize.query(interestVector, {
  topK: 100,
  returnValues: false,
  returnMetadata: false,
});
vectorMatches = queryResult.matches.map(m => ({ id: m.id, score: m.score }));
```

Cloudflare Vectorize による近似最近傍探索。上位100件を取得。

#### 2.2.3 フォールバック: D1 コサイン類似度

Vectorizeが利用できない場合、D1の `post_embeddings` テーブルから全埋め込みを取得し、クライアントサイドでコサイン類似度を計算:

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
```

$\text{cos}(a, b) = \frac{a \cdot b}{\|a\| \cdot \|b\|}$

ただし直近1000件のみ対象（パフォーマンス制約）。

#### 2.2.4 ハイブリッドスコアリング

```typescript
const hybrid = candidatePosts.map(p => {
  const vecSim = (vecScoreMap.get(p.id) || 0) / maxVec;
  const engNorm = (Number(p.eng_score) || 0) / maxEng;
  return { post: p, score: 0.7 * vecSim + 0.3 * engNorm };
});
```

**ハイブリッドスコア**:

$$
\text{score}(p) = 0.7 \times \frac{\text{vecSim}(p)}{\max\text{Vec}} + 0.3 \times \frac{\text{engScore}(p)}{\max\text{Eng}}
$$

ただし:

$$
\text{engScore}(p) = \frac{\text{engagement\_hotness}_p}{(\text{hours\_ago} + 2.0)}
$$

**エンゲージメントホットネス**は別フィールドとしてテーブルに保存（更新ロジックは別途必要）。

#### 2.2.5 ダイバーシフィケーション

```typescript
function diversifyPosts(items, maxCount, maxPerUser) {
  const userCounts = new Map();
  const result = [];
  for (const item of items) {
    if (result.length >= maxCount) break;
    const userId = String(item.post.user_id);
    const count = userCounts.get(userId) || 0;
    if (count >= maxPerUser) continue;  // 同一ユーザー最大3件
    userCounts.set(userId, count + 1);
    result.push(item);
  }
  return result;
}
```

同一著者あたり最大3件の制限。

#### 2.2.6 フォールバック: エンゲージメントベース

興味ベクトルがない場合（未ログインユーザー等）、純粋なエンゲージメントスコアでソート:

```sql
SELECT ..., (p.engagement_hotness / ((unixepoch('now') - unixepoch(p.created_at)) / 3600.0 + 2.0)) as score
FROM posts p
WHERE ... 
ORDER BY score DESC, p.created_at DESC
```

#### 2.2.7 ブロックフィルター

```typescript
if (currentUserId) {
  const blockedIds = await c.env.DB.prepare(
    'SELECT blocked_id FROM blocks WHERE blocker_id = ?'
  ).bind(currentUserId).all();
  // blockedSet に含まれるユーザーの投稿を除外
}
```

### 2.3 類似投稿 (`GET /api/posts/:id/similar`)

**Path**: `functions/api/[[route]].ts` (4933行目)

指定された投稿とベクトル的に類似した投稿を返す。

```typescript
// Vectorize版
const result = await vectorize.query(vector, {
  topK: limit + 1,
});

// フォールバック: D1版 (直近100件のみ)
const allRows = await c.env.DB.prepare(
  'SELECT post_id, embedding FROM post_embeddings ORDER BY created_at DESC LIMIT 100'
).all();
// コサイン類似度でソート
scored.sort((a, b) => b.sim - a.sim);
```

### 2.4 トレンドハッシュタグ (`GET /api/tags/trending`)

**Path**: `functions/api/[[route]].ts` (4544行目)

```sql
WITH recent_posts AS (
  SELECT id, hashtags FROM posts
  WHERE hidden = 0 AND status = 'published'
  ORDER BY created_at DESC LIMIT ?
)
SELECT value AS tag, COUNT(*) AS count,
  ROUND(COUNT(*) * 100.0 / ?, 1) AS percentage
FROM recent_posts, json_each(recent_posts.hashtags)
GROUP BY value
ORDER BY count DESC LIMIT 5
```

直近N件（デフォルト100）の投稿から、ハッシュタグ出現率Top5を返す。単純な頻度カウントだが、トレンドの変化を捉えるには十分。

### 2.5 ゲーム推薦 (`GET /api/games?recommended=true`)

**Path**: `functions/api/[[route]].ts` (1536行目)

- `recommended=true`: ユーザーの興味/睡眠データに基づくパーソナライズ
- `shuffle=true`: 未ログインユーザー向けシャッフル

### 2.6 広告注入 (`src/lib/inject-ads.ts`)

**Path**: `src/lib/inject-ads.ts`

クライアントサイドでN件ごとに広告を注入。パーソナライズなし、完全ランダム選択。

---

## 3. 現状のアルゴリズム限界

### 3.1 スケーラビリティ問題

| 問題点 | 詳細 |
|-------|------|
| **DBフルスキャン** | `ORDER BY score DESC` にインデックスが効かない |
| **D1制約** | 1000件上限のフォールバック |
| **Vectorize availability** | ベクトル検索が常に利用可能とは限らない |
| **冷え切った投稿** | 時間減衰が強すぎて新規投稿が埋もれる |

### 3.2 アルゴリズム的問題

| 問題点 | 詳細 |
|-------|------|
| **パーソナライズ不足** | Trendingは完全に非個人化 |
| **エンゲージメントバイアス** | 既に人気のある投稿がさらに有利に |
| **フィルターバブル対策なし** | 探索と活用のトレードオフ未実装 |
| **コンテンツタイプ未考慮** | SWF/ゲーム/動画/テキストで特性が異なる |
| **スパム対策の不在** | エンゲージメントファーミングに脆弱 |
| **新規投稿の発見性** | 時間減衰とスコア閾値で埋もれる |
| **再現性** | cursorベースのページネーションが不安定 |

### 3.3 インフラ問題

| 問題点 | 詳細 |
|-------|------|
| **コールドスタート** | 新規ユーザーに興味ベクトルがない |
| **D1 Query制限** | Workers有料プランでもD1の行数制限 |
| **Vectorize更新頻度** | 埋め込み更新がリアルタイムでない |
| **キャッシュ戦略** | 30秒KVキャッシュのみ |

### 3.4 阻害信号の不在

- **ミュート・ブロック**は考慮されるが、**Negative Feedback**（興味ない、報告など）が推薦に反映されていない
- **滞在時間**（dwell time）はゲームのみ収集。通常投稿の滞在時間未収集
- **クリック・閲覧時間**などの暗黙的シグナルが未活用
