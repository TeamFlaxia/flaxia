# Flaxia 技術ホワイトペーパー

## エグゼクティブサマリー

Flaxiaは、ソーシャルメディアの投稿を生きたインタラクティブなアプリケーションとして再定義する、革新的な時系列ソーシャル・ネットワーキング・サービス（SNS）です。従来のプラットフォームが静的なテキストやメディアを扱うのに対し、FlaxiaではユーザーがHTML5アプリケーション、Unity WebGLゲーム、Flashアニメーションなどの動的コンテンツをZIPファイルとして投稿できます。

Cloudflareのエッジコンピューティングインフラ上に構築されたFlaxiaは、サーバーレスアーキテクチャを活用し、高いスケーラビリティ、セキュリティ、パフォーマンスを実現しています。ActivityPubプロトコルを通じたFediverse（連合型ソーシャルネットワーク）との統合により、分散型ソーシャルネットワーキングを可能にしつつ、独自のインタラクティブコンテンツ機能を維持しています。

## 技術アーキテクチャ

### コアインフラストラクチャ

Flaxiaは、グローバルなスケーラビリティと低レイテンシーのコンテンツ配信のために設計された、モダンなエッジコンピューティングスタック上で動作します。

**実行環境**
- **Cloudflare Pages**: 静的アセットのホスティングとフロントエンドのデプロイ
- **Cloudflare Workers**: エッジでのサーバーレスAPI実行
- **互換性日付**: 2024-01-01（Node.js互換フラグ付き）

**データベース層**
- **Cloudflare D1**: SQLiteベースの分散データベース
- **マイグレーションシステム**: バージョン管理によるスキーマ進化
- **クエリ最適化**: 一般的なアクセスパターンに対するインデックス付きクエリ

**ストレージインフラ**
- **Cloudflare R2**: メディアファイルとZIPペイロードのオブジェクトストレージ
- **CDN統合**: 自動的なグローバルコンテンツキャッシング
- **ファイルサイズ制限**: アップロード最大10MB、ZIP展開時最大100MB

**メッセージキュー**
- **Cloudflare Queues**: 連合コンテンツのためのActivityPub配信キュー
- **非同期処理**: ノンブロッキングな連合運用

### APIアーキテクチャ

**フレームワーク**: Hono — Cloudflare Workers向けの軽量で型安全なWebフレームワーク

**API構造**:
```
/api/
  /auth/*          - 認証エンドポイント
  /upload/*        - ファイル直接アップロード（事前署名）
  /images/*        - R2からの画像プロキシ
  /audio/*         - 音声ファイルプロキシ
  /zip/*           - ZIPファイル配信
  /wvfs-zip/*      - WVFS仮想ファイルシステム
  /swf/*           - Flashファイル配信
  /ads/*           - 広告ペイロード
  /thumbnail/*     - サムネイル画像
  /actors/*        - ActivityPubアクターエンドポイント（WIP）
  /.well-known/*   - WebFingerプロトコル（WIP）
  /notifications/* - ユーザー通知（WIP）
  /admin/*         - 管理機能（WIP）
```

**認証ミドルウェア**:
- セキュアクッキーを使用したセッションベース認証
- ゲストアクセスのための公開ルート検出
- 不正利用防止のためのレート制限統合
- 保護されたルートのためのユーザーコンテキスト注入

**レート制限**:
- Cloudflare KVベースの分散レート制限
- エンドポイントごとの制限（例: 登録3回/時間、ログイン20回/時間）
- CF-Connecting-IPヘッダーによるIPベースの追跡

### データベーススキーマ

**コアテーブル**:

```sql
-- ユーザーと認証
users (id, email, password_hash, username, display_name, bio, avatar_key, language, ng_words, created_at)
sessions (id, user_id, expires_at)

-- コンテンツとインタラクション
posts (id, user_id, username, text, hashtags, gif_key, payload_key, fresh_count, created_at, status)
replies (id, post_id, user_id, username, text, created_at)
freshs (post_id, user_id) -- "Fresh"投票（独自のエンゲージメント機構）

-- ソーシャルグラフ
follows (follower_id, followee_id)

-- ActivityPub連合
actor_keys (user_id, public_key_pem, private_key_pem, created_at)
ap_followers (user_id, follower_url, created_at)

-- 通知
notifications (id, user_id, type, post_id, actor_id, read, created_at)

-- モデレーション
reports (id, reporter_id, post_id, category, reason, created_at)
hidden_posts (id, post_id, moderator_id, reason, created_at)

-- 広告システム
ads (id, title, body_text, click_url, payload_key, payload_type, impressions, clicks, active, created_at)
ad_interactions (id, ad_id, interaction_type, created_at)
```

**インデックス**: 時系列フィード、ユーザープロフィール、ソーシャルグラフ探索などの一般的なクエリパターンに最適化されています。

## インタラクティブコンテンツシステム

### ZIP実行エンジン

Flaxiaの中核となる革新は、投稿を実行可能なアプリケーションとして扱う機能です。これは高度なZIP実行パイプラインによって実現されます。

**クライアント側実行**（`src/lib/zip-executor.ts`）:

1. **ZIP取得**: R2ストレージからZIPファイルを取得
2. **検証**: 以下を含む包括的なセキュリティチェック:
   - ファイル数制限（最大255ファイル）
   - パス長制限（最大255文字）
   - ディレクトリ深度制限（最大10階層）
   - 合計サイズ検証（展開時最大100MB）
   - ネストされたZIPの防止
   - シンボリックリンクの検出
   - パストラバーサル対策
   - ファイルタイプホワイトリストの適用

3. **Blob URL生成**: ZIPコンテンツをブラウザアクセス可能なBlob URLに変換
4. **HTML書き換え**: `index.html`内の全アセット参照をBlob URLに書き換え
5. **サンドボックス実行**: 制限された権限で隔離されたiframe内でコンテンツを実行

**許可されるファイルタイプ**:
- Webコンテンツ: `.html`, `.css`, `.js`, `.json`, `.txt`
- メディア: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.mp3`, `.wav`, `.ogg`, `.mp4`, `.webm`
- WebGL/ゲーム: `.wasm`, `.glsl`, `.wgsl`, `.unityweb`, `.data`, `.wasm.code`, `.wasm.framework`
- レガシー: `.ico`, `.rsp`

### WVFS（Web仮想ファイルシステム）

サーバー側のWVFSシステム（`src/lib/wvfs-zip-server.ts`）は、ZIPアーカイブからの効率的なファイル配信を提供します。

**アーキテクチャ**:
- **インメモリストレージ**: 展開されたZIPコンテンツのマップベース保存
- **パス正規化**: 相対パスとディレクトリトラバーサルの処理
- **フォールバック解決**: ファイルが見つからない場合の複数ルックアップ戦略
- **ベースタグ注入**: HTMLファイルへの自動ベースURL注入

**配信パイプライン**:
1. **展開**: `fflate`を使用したサーバー側ZIP展開
2. **検証**: クライアント側と同様のセキュリティチェック
3. **保存**: 展開されたファイルをメモリにキャッシュ
4. **配信**: 適切なMIMEタイプでファイル要求に応答
5. **クリーンアップ**: 未使用ZIPのメモリ管理

**APIエンドポイント**:
- `GET /api/wvfs-zip/:postId/*` - 個別ファイルの配信
- `GET /api/wvfs-zip/:postId` - index.htmlをデフォルトで配信

### セキュリティサンドボックス

**分離戦略**:
```html
<iframe 
  sandbox="allow-scripts allow-pointer-lock allow-fullscreen"
  allow="fullscreen"
  referrerpolicy="no-referrer">
```

**権限**:
- `allow-scripts`: インタラクティブコンテンツに必要なJavaScript実行
- `allow-pointer-lock`: ゲームコントロール入力
- `allow-fullscreen`: 没入型体験
- **明示的に拒否**: `allow-same-origin`, `allow-forms`, `allow-popups`

**セキュリティ上の利点**:
- 親ウィンドウのDOMにアクセス不可
- クッキーやlocalStorageにアクセス不可
- 異なるオリジンへのネットワーク要求不可
- 分離されたJavaScript実行コンテキスト

### Fresh Bridge API

Fresh Bridge（`sandbox/fresh-bridge.js`）は、サンドボックス内のコンテンツと親アプリケーション間の安全な通信を可能にします。

**APIメソッド**:
```javascript
FreshBridge.requestFullscreen()   // フルスクリーンモードを要求
FreshBridge.requestFresh()        // "Fresh"投票を要求
FreshBridge.postScore(score, label)  // ゲームスコアを送信
FreshBridge.onMessage(callback)   // 親からのメッセージを監視
```

**メッセージタイプ**:
- `REQUEST_FULLSCREEN`: 親がフルスクリーンを要求
- `FULLSCREEN_GRANTED/DENIED`: フルスクリーン要求への応答
- `REQUEST_FRESH`: ユーザーが"Fresh"投票を要求
- `FRESH_GRANTED/DENIED`: Fresh要求への応答
- `POST_SCORE`: ゲームスコアをラベル付きで送信
- `SCORE_SUBMITTED`: スコア送信の確認

**セキュリティ**:
- `FRESH_PARENT_ORIGIN`を使用したオリジン検証
- 明示的なオリジンチェック付きPostMessage通信
- 型安全なメッセージ処理

## ソーシャル機能

### 認証システム

**カスタムセッションベース認証**（`functions/lib/auth.ts`）:

**パスワードセキュリティ**:
- PBKDF2 with SHA-256（100,000イテレーション）
- パスワードごとに16バイトのランダムソルト
- タイミング攻撃を防ぐためのタイミングセーフ比較
- base64でのソルト＋ハッシュの複合保存

**セッション管理**:
- 7日間のセッション有効期限
- Secure、HttpOnly、SameSite=Laxのクッキー
- UUIDベースのセッショントークン（32文字）
- データベースバックアップのセッションストレージ（有効期限付き）

**ユーザー登録**:
- 正規表現によるメールアドレス検証
- パスワード要件（8〜128文字）
- ユーザー名検証（英数字、1〜20文字）
- 大文字小文字を区別しないユーザー名の一意性
- 表示名の制限（最大50文字）

### ソーシャルグラフ

**フォローシステム**:
- 双方向のフォロー関係
- 冪等性を保つ`INSERT OR IGNORE`
- インデックスを使用した効率的なフォロワー/フォロー中クエリ
- フォローしていないユーザーに基づくユーザー提案

**アクティビティフィード**:
- 時系列の投稿順序
- ハッシュタグとタグ付けのサポート
- エンゲージメント指標のためのFresh投票カウント
- 会話のための返信スレッド

### コンテンツインタラクション

**Fresh投票システム**:
- 独自の"Fresh"エンゲージメント機構（いいねに類似）
- データベースによる一意性の強制（post_id + user_idの主キー）
- リアルタイムのFreshカウント更新
- Fresh Bridgeを介したインタラクティブコンテンツとの統合

**返信システム**:
- スレッド化された会話
- 返信への返信のサポート
- スレッド内の時系列順序
- ユーザー属性とタイムスタンプ

**通知**:
- マルチタイプ通知システム（reported、fresh、warned、hidden）
- 未読カウント追跡
- 一括既読機能
- 連合通知のためのアクター情報

## ActivityPub統合

### Fediverse互換性

Flaxiaは、分散型ソーシャルネットワーキングのためにActivityPubプロトコルの一部を実装しています。

**アクター表現**:
```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Person",
  "id": "https://flaxia.app/api/actors/username",
  "preferredUsername": "username",
  "name": "Display Name",
  "summary": "Bio",
  "inbox": "https://flaxia.app/api/users/username/inbox",
  "outbox": "https://flaxia.app/api/actors/username/outbox",
  "followers": "https://flaxia.app/api/actors/username/followers",
  "following": "https://flaxia.app/api/actors/username/following",
  "publicKey": {
    "id": "https://flaxia.app/api/actors/username#main-key",
    "owner": "https://flaxia.app/api/actors/username",
    "publicKeyPem": "PEM-encoded public key"
  }
}
```

**暗号セキュリティ**（`functions/lib/activitypub/signature.ts`）:

**鍵管理**:
- ユーザーごとに生成されるRSA鍵ペア
- データベースにPEM形式で保存
- アクターエンドポイントで公開鍵を公開
- 秘密鍵は送信リクエストの署名に使用

**HTTP署名検証**:
- RSASSA-PKCS1-v1_5 with SHA-256
- date、digest、hostヘッダーを使用したリクエスト署名
- 署名ヘッダーの解析と検証
- URLセーフ文字処理を含むBase64デコード
- リプレイ攻撃対策（±30分のタイムスタンプウィンドウ）

**Digest検証**:
- リクエストボディのSHA-256ハッシュ
- Digestヘッダーの検証
- コンテンツ整合性の検証

**コンテンツタイプ**:
- **Note**: 個別の投稿コンテンツ
- **Create**: ノート作成のアクティビティ
- **Delete**: ノート削除のアクティビティ
- **Follow**: アクターをフォローするアクティビティ
- **Accept/Reject**: フォローリクエストへの応答

**WebFingerプロトコル**:
- `acct:username@domain`によるユーザー検出
- Resourceパラメータの検証
- BASE_URLに対するドメインマッチング
- 大文字小文字を区別しないユーザー名検索

## 広告システム

### インタラクティブ広告プラットフォーム

Flaxiaは、同じインタラクティブコンテンツインフラを活用した高度な広告システムを備えています。

**広告タイプ**:
- **ZIP**: インタラクティブアプリケーション（投稿と同様）
- **SWF**: Flashアニメーション
- **GIF**: アニメーション画像
- **Image**: 静止画像

**広告構造**:
```sql
ads (id, title, body_text, click_url, payload_key, 
     payload_type, impressions, clicks, active, created_at)
```

**インタラクション追跡**:
- ZIP/SWF広告の再生追跡
- インプレッション計測
- クリック率測定
- 広告ごとのインタラクションログ

**配信戦略**:
- アクティブな広告からランダム選択
- `/api/ads/:id/payload`経由のペイロード配信
- プレビューのためのサムネイル対応
- ZIP広告のWVFS統合

## セキュリティとプライバシー

### マルチレイヤーセキュリティ

**コンテンツ検証**:
- ZIPファイル構造の検証
- ファイルタイプホワイトリストの適用
- サイズ制限（アップロード時および展開時）
- パストラバーサル対策
- シンボリックリンクの検出
- ネストされたアーカイブの防止

**サンドボックス分離**:
- 制限された権限のiframeサンドボックス
- 同一オリジンアクセス不可
- クッキー/ストレージアクセス不可
- ネットワーク要求制限
- Referrerポリシーの適用

**入力サニタイズ**:
- DOMPurifyによるHTMLサニタイズ
- 安全な設定のMarkdown-it
- 安全な数式レンダリングのKaTeX
- ユーザー入力の長さ制限

**レート制限**:
- IPごとのエンドポイント制限
- 分散KVストレージ
- 時間ベースのウィンドウ
- エンドポイントごとに設定可能な制限

### プライバシー保護

**ユーザープライバシーコントロール**:
- NGワードフィルタリング（ユーザー設定可能）
- コンテンツ可視性設定（公開/フォロワー/非公開）
- プロフィール情報の制御
- アバターキー管理

**データ最小化**:
- 必要最小限のデータ収集
- セッションベース認証（localStorageにトークンなし）
- セキュアクッキー属性
- APIレスポンスでのデータ露出最小化

**コンテンツモデレーション**:
- ユーザー報告システム
- 管理者によるコンテンツ非表示
- カテゴリベースの報告
- モデレーター監査証跡

## パフォーマンスとスケーラビリティ

### エッジコンピューティングの利点

**グローバル分散**:
- Cloudflareの300以上のエッジロケーション
- 最寄りのエッジへの自動リクエストルーティング
- グローバルユーザー向けの低レイテンシー
- 単一障害点なし

**サーバーレスアーキテクチャ**:
- トラフィックに基づく自動スケーリング
- サーバー管理のオーバーヘッドなし
- 従量課金モデル
- Pages Functionsによるコールドスタートゼロ

### キャッシング戦略

**静的アセット**:
- 画像/音声の長期キャッシュヘッダー（1年）
- CDNレベルのキャッシング
- コンテンツ更新時のキャッシュ無効化

**動的コンテンツ**:
- データベースクエリの最適化
- 一般的なパターンのインデックス付きルックアップ
- JOINクエリを使用したセッションキャッシング
- KVベースのレート制限キャッシング

**WVFS最適化**:
- インメモリファイル配信
- キャッシュヒットのためのパス正規化
- 効率的なBlob URL生成
- 未使用ZIPのクリーンアップ

### パフォーマンスモニタリング

**クライアント側メトリクス**:
- Performance API統合
- ナビゲーションタイミング追跡
- リソース読み込み監視
- カスタムパフォーマンスイベント

**サーバー側ロギング**:
- リクエスト/レスポンスロギング
- エラー追跡
- ActivityPub配信ログ
- セキュリティイベント監視

## 今後の開発計画

### 拡張性

**プラグインアーキテクチャ**:
- コンポーネントベースのフロントエンド設計
- モジュール化されたAPIエンドポイント
- プラグイン可能なコンテンツタイプ
- 拡張可能なFresh Bridge API

**連合機能の強化**:
- 完全準拠のActivityPubサポート
- クロスプラットフォームのコンテンツ共有
- 改善された発見メカニズム
- 強化されたセキュリティプロトコル

### スケーラビリティロードマップ

**コンテンツ配信**:
- WVFSキャッシングの強化
- 分散ZIP展開
- エッジベースのコンテンツ前処理
- 適応型品質ストリーミング

**ユーザー増加への対応**:
- 水平方向のデータベーススケーリング
- シャーディング戦略
- 地理的データ分散
- 負荷分散の最適化

**機能拡張**:
- リアルタイムコラボレーション
- マルチユーザーインタラクティブコンテンツ
- 強化されたモデレーションツール
- 高度な分析プラットフォーム

## 結論

Flaxiaは、静的な投稿を生きたインタラクティブなアプリケーションに変革することで、ソーシャルネットワーキングにパラダイムシフトをもたらします。最新のエッジコンピューティングインフラを活用し、堅牢なセキュリティ対策を実装し、ActivityPubを通じた分散型連合を採用することで、Flaxiaは次世代のソーシャルコンテンツのための、スケーラブルで安全かつ革新的なプラットフォームを提供します。

サンドボックス実行、包括的な検証、プライバシー保護に重点を置いたアーキテクチャにより、ユーザーはデータとソーシャルコネクションをコントロールしながら、インタラクティブな体験を安全に作成・共有できます。プラットフォームの進化に伴い、モジュラー設計と拡張可能なアーキテクチャは、ソーシャルメディアのインタラクティビティにおける継続的な革新をサポートします。
