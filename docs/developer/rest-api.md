# Flaxia REST API

`flaxia.app` が公開する REST API の一覧です。ゲーム内のサンドボックスからは
呼び出せません（オペーン origin のため）。連携アプリ・サーバー側統合・
管理ツールから使います。

> 詳細なリクエスト/レスポンスは [../api.md](../api.md) 、認証・暗号化は
> [../e2ee.md](../e2ee.md) 、DB スキーマは [../database.md](../database.md) を参照してください。

---

## 1. 共通

| 項目 | 値 |
|---|---|
| Base URL | `https://flaxia.app` |
| 形式 | JSON（アップロードは `multipart/form-data` または binary） |
| 認証 | セッション Cookie（`SameSite=Lax`）、または Native アプリは `X-Flaxia-Native-App` |
| CORS | `flaxia.app` と明示的に許可されたオリジンのみ |
| CSRF | セッションを伴う state-changing メソッドは CSRF トークンが必要 |
| ページネーション | `cursor`（ISO8601 `created_at`）+ `limit`（既定 20、上限は各エンドポイント） |

### エラーレスポンス

```json
{ "error": "Human readable message" }
```

| ステータス | 意味 |
|---|---|
| 400 | バリデーションエラー |
| 401 | 未認証 |
| 403 | 権限なし |
| 404 | リソースなし |
| 409 | 競合（例: 重複、バージョン不一致） |
| 429 | レート制限 |
| 503 | 機能が設定されていない |

---

## 2. 認証

SRP-6a を採用し、パスワードはサーバーに送信されません。

### SRP ログイン

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/auth/login/start` | `{ username }` → `{ challenge_id, salt, B, srp_kdf }` |
| POST | `/api/auth/login/verify` | `{ challenge_id, A, M1 }` → セッション Cookie |

`srp_kdf` は `sha256-v1`（PBKDF2 600k）です。

### その他の認証

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/auth/mode` | 認証モード |
| GET | `/api/auth/start` | Auth オリジンへ 302（PKCE verifier を Cookie に保存） |
| GET | `/api/auth/callback` | `code` を交換してセッション Cookie 発行 |
| POST | `/api/auth/register` | `{ username, display_name, srp: { salt, verifier, group, kdf } }` |
| POST | `/api/auth/reauth/start` | 再認証チャレンジ開始 |
| POST | `/api/auth/reauth/verify` | `{ challenge_id, A, M1 }` → `{ valid }` |
| POST | `/api/auth/upgrade-srp` | レガシーアカウントを SRP に移行 |
| POST | `/api/auth/logout` | ログアウト |
| POST | `/api/auth/login` | **非推奨**（レガシー明文パスワード用） |

### Flaxia Auth 連携

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/auth/flaxia/provision` | アカウントプロビジョン |
| POST | `/api/auth/flaxia/exchange` | grant 交換 |
| POST | `/api/auth/flaxia/credential-recovery/start` | 資格情報リカバリ開始 |
| POST | `/api/auth/flaxia/credential-recovery/verify` | 資格情報リカバリ検証 |
| POST | `/api/auth/recovery/enroll` | リカバリ登録 |
| POST | `/api/auth/recovery/reauth/start` | リカバリ再認証 |
| GET | `/api/auth/recovery/status` | リカバリ状態 |

---

## 3. セッション

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| GET | `/api/me` | 必須 | 現在ユーザー（`ng_words` 含む） |
| PATCH | `/api/users/me` | 必須 | プロフィール更新（`equipped_title_id` 等） |
| PATCH | `/api/users/me/email` | 必須 | メール変更（再認証必要） |
| PATCH | `/api/users/me/password` | 必須 | パスワード変更（Vault 再ラップ必要） |
| POST | `/api/users/me/avatar` | 必須 | アバター画像アップロード |
| DELETE | `/api/users/me` | 必須 | アカウント削除 |
| GET | `/api/users/me/blocked` | 必須 | ブロック一覧 |

---

## 4. ユーザー

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| GET | `/api/users/:username` | 任意 | プロフィール |
| GET | `/api/users/:username/followers` | 任意 | フォロワー |
| GET | `/api/users/:username/following` | 任意 | フォロー中 |
| POST | `/api/users/:username/follow` | 必須 | フォロー |
| DELETE | `/api/users/:username/follow` | 必須 | アンフォロー |
| POST | `/api/users/:username/block` | 必須 | ブロック |
| DELETE | `/api/users/:username/block` | 必須 | ブロック解除 |
| POST | `/api/follows/:id` | 必須 | フォロー（ID 指定） |
| DELETE | `/api/follows/:id` | 必須 | アンフォロー（ID 指定） |
| POST | `/api/remote-follow` | 必須 | リモート（ActivityPub）フォロー |
| DELETE | `/api/remote-follow` | 必須 | リモートアンフォロー |
| GET | `/api/users/suggest` | 必須 | ユーザー提案 |
| GET | `/api/users/suggestions` | 必須 | ユーザー提案（別実装） |
| GET | `/api/users/:username/pinned` | 任意 | ピン投稿 |
| POST | `/api/profile/pin` | 必須 | 投稿をピン |
| DELETE | `/api/profile/pin` | 必須 | ピン解除 |
| POST | `/api/users/me/credentials/retry` | 必須 | 資格情報リトライ |
| POST | `/api/users/me/deletion/retry` | 必須 | 削除リトライ |

---

## 5. タイトル

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/titles` | タイトル一覧（プラットフォーム + ゲーム称号） |
| GET | `/api/titles/me` | 所持タイトル |
| PUT | `/api/titles/me/equipped` | 装備（`{ titleId }`、`null` で外す） |
| POST | `/api/titles/game` | ゲーム称号を登録（要認証・ゲーム投稿の作者のみ） |
| POST | `/api/titles/game/award` | 登録済みゲーム称号を本人に付与（要認証・冪等） |

`POST /api/titles/game` のボディは
`{ postId, titleId, name, nameJa?, description?, descriptionJa?, icon? }` です。
`postId` は実行中のゲーム投稿で、親（`src/lib/game-badge-bridge.ts`）が
`event.source` から解決して付与します。ゲームコードからは直接指定できません。
`icon` は同一オリジンのパスのみ。定義は `titleId` ごとに書き込み一回限りです。

`POST /api/titles/game/award` は登録済みの称号だけを本人に付与します。未登録は
404 `TITLE_NOT_FOUND`、他ゲーム・プラットフォームの `titleId` は 409
`TITLE_CONFLICT` で拒否されます。ゲームからは Game API の `AWARD_TITLE` を
使ってください
（[Game API](game-api.md#47-バッジ称号)）。

---

## 6. 投稿

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| GET | `/api/posts` | 任意 | タイムライン（`cursor`, `limit`） |
| GET | `/api/posts/trending` | 任意 | トレンド |
| GET | `/api/posts/recommended` | 任意 | おすすめ（`client_rank=1` でベクトル返却） |
| GET | `/api/posts/:id` | 任意 | 投稿詳細 |
| GET | `/api/posts/:id/thread` | 任意 | スレッド |
| GET | `/api/posts/:id/replies` | 任意 | 返信一覧 |
| GET | `/api/posts/:id/similar` | 任意 | 類似投稿 |
| POST | `/api/posts` | 必須 | 投稿作成（multipart） |
| PUT | `/api/posts/:id` | 必須 | 投稿編集 |
| DELETE | `/api/posts/:id` | 必須 | 投稿削除 |
| POST | `/api/posts/:id/fresh` | 必須 | Fresh トグル |
| POST | `/api/posts/fresh/batch` | 必須 | Fresh 一括 |
| POST | `/api/posts/:id/reload` | 必須 | Reload（リツイート）トグル |
| POST | `/api/posts/:id/share` | 必須 | （非推奨）reload エイリアス |
| POST | `/api/posts/:id/bookmark` | 必須 | ブックマーク |
| DELETE | `/api/posts/:id/bookmark` | 必須 | ブックマーク解除 |
| POST | `/api/posts/:id/impression` | 必須 | インプレッション |
| POST | `/api/posts/impressions/batch` | 必須 | インプレッション一括 |
| POST | `/api/posts/:id/reactions` | 必須 | リアクション |
| POST | `/api/posts/:id/counter-notice` | 必須 | カウンター通知 |
| GET | `/api/bookmarks` | 必須 | ブックマーク一覧 |
| GET | `/api/freshs` | 必須 | Fresh 一覧 |

### 下書き（投稿）

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/posts/prepare` | 添付用 URL 発行（`files` で複数） |
| POST | `/api/posts/commit` | 下書き確定 |
| POST | `/api/posts/:id/prepare-media` | 公開投稿への添付追加 |
| POST | `/api/posts/:id/prepare-attachment` | 添付準備（旧） |
| POST | `/api/posts/:id/replies/prepare` | 返信の添付準備 |
| POST | `/api/posts/:id/replies/commit` | 返信確定 |

### 投稿バージョン

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/posts/:id/versions` | バージョン一覧 |
| POST | `/api/posts/:id/versions/prepare` | 新バージョンの添付準備 |
| POST | `/api/posts/:id/versions/commit` | 新バージョン確定 |

---

## 7. 検索 / トレンド

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/search` | `q`, `type=posts|users|hashtags` |
| GET | `/api/tags/trending` | トレンドタグ |
| GET | `/api/tags/suggest` | タグ補完 |
| GET | `/api/current-topic` | 現在の話題 |

---

## 8. メディア / アップロード

| メソッド | パス | 説明 |
|---|---|---|
| PUT | `/api/upload/:key` | R2 へ binary アップロード |
| GET | `/api/images/*` | 画像 |
| GET | `/api/audio/*` | 音声 |
| GET | `/api/video/*` | 動画 |
| GET | `/api/documents/*` | PDF など |
| GET | `/api/thumbnail/:id` | サムネイル |
| GET | `/api/zip/:postId` | ZIP 取得 |
| GET | `/api/swf/:postId` | SWF 取得 |
| GET | `/api/wvfs-zip/:postId/*` | WVFS ゲームドキュメント |
| GET | `/api/game-loader/:postId` | ゲームローダー |
| GET | `/api/game-loader/:postId/archive` | ゲームローダーアーカイブ |

---

## 9. アンケート / スタンプ

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/polls/:postId` | アンケート取得 |
| POST | `/api/polls/:pollId/vote` | 投票 |
| GET | `/api/stamps` | スタンプ一覧 |
| GET | `/api/stamps/all` | 全スタンプ |
| POST | `/api/stamps` | スタンプ作成 |
| DELETE | `/api/stamps/:id` | スタンプ削除 |

---

## 10. 通知 / Push

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/notifications` | 通知一覧 |
| POST | `/api/notifications/read-all` | すべて既読 |
| GET | `/api/push/vapid-key` | VAPID 公開鍵 |
| POST | `/api/push/register` | プッシュ登録 |
| POST | `/api/push/unregister` | プッシュ解除 |

---

## 11. マルチプレイ

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| POST | `/api/multiplayer/rooms` | 必須 | ルーム作成 `{ gameId, maxPlayers?, isPublic?, metadata? }` |
| GET | `/api/multiplayer/rooms` | 必須 | 公開ルーム一覧（`gameId`, `status`） |
| GET | `/api/multiplayer/rooms/:id` | 必須 | ルーム詳細（非公開は参加者のみ） |
| POST | `/api/multiplayer/rooms/:id/join` | 必須 | 参加 |
| POST | `/api/multiplayer/rooms/:id/leave` | 必須 | 退出 |
| POST | `/api/multiplayer/rooms/:roomId/socket-ticket` | 必須 | Native 用 WebSocket チケット |
| POST | `/api/multiplayer/matchmaking` | 必須 | マッチメイク（`join` / `leave` / `check`） |
| POST | `/api/multiplayer/scores` | 必須 | スコア投稿 `{ gameId, score, label?, metadata? }` |
| GET | `/api/multiplayer/scores/:gameId` | 任意 | リーダーボード（`limit`, `userId`） |

### WebSocket

| パス | 説明 |
|---|---|
| `/api/ws/multiplayer?roomId=&gameId=&ticket=` | マルチプレイシグナリング（Native は `ticket`、ブラウザは Cookie） |

---

## 12. ゲーム（Arcade）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/games` | ゲーム一覧（`shuffle`, `trending`, `recommended`, `cursor`, `limit`, `initialId`） |
| POST | `/api/games/events` | プレイイベント一括（`view`, `fresh`, `reply`, `fullscreen`, `share`） |
| POST | `/api/games/dwell` | 滞在時間記録 |

---

## 13. 広告

### 公開

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/ads/active` | 有効広告（ランダム） |
| POST | `/api/ads/:id/impression` | インプレッション |
| POST | `/api/ads/:id/click` | クリック |
| POST | `/api/ads/:id/interaction` | インタラクション時間 |
| POST | `/api/ads/:id/play` | 再生 |
| GET | `/api/ads/:id/payload` | 広告ペイロード |
| PUT | `/api/ads/:id` | 広告更新 |

### 管理

| メソッド | パス |
|---|---|
| GET | `/api/admin/ads` |
| POST | `/api/admin/ads` |
| PATCH | `/api/admin/ads/:id` |
| DELETE | `/api/admin/ads/:id` |
| GET | `/api/admin/ads/config` |
| PATCH | `/api/admin/ads/config` |

---

## 14. メール

[../mail.md](../mail.md) を参照。

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/mail/addresses` | アドレス一覧 |
| POST | `/api/mail/addresses` | アドレス作成 |
| GET | `/api/mail/quota` | 容量 |
| GET | `/api/mail/unread` | 未読 |
| GET | `/api/mail/keys` / `/keys/me` | 公開鍵 |
| PUT | `/api/mail/keys/me` | 鍵登録 |
| GET | `/api/mail/threads` / `/threads/:id` | スレッド |
| GET | `/api/mail/messages/:id` | メッセージ |
| GET | `/api/mail/messages/:id/payload` | 生ペイロード |
| GET | `/api/mail/messages/:id/attachments/:attachmentId` | 添付 |
| POST | `/api/mail/messages` | 送信 |
| POST | `/api/mail/messages/actions` | 既読などの一括操作 |
| POST | `/api/mail/external-send` | 外部送信 |
| GET/POST/PATCH/DELETE | `/api/mail/drafts[/:id]` | 下書き |
| POST | `/api/mail/report-abuse` | 通報 |

---

## 15. ActivityPub

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/.well-known/webfinger` | WebFinger |
| GET | `/api/actors/:username` | Actor |
| GET | `/api/actors/:username/followers` | フォロワー |
| GET | `/api/actors/:username/following` | フォロー中 |
| GET | `/api/actors/:username/outbox` | Outbox |
| GET | `/api/notes/:noteId` | Note |
| GET | `/notes/:noteId` | Note（公開） |
| POST | `/api/actors/:username/inbox` | リモート Inbox |
| POST | `/api/inbox` | ローカル Inbox |

---

## 16. 課金

### Flaxia+（サブスクリプション）

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/billing/checkout` | Checkout セッション作成 `{ planId: "flaxia_plus" }` |
| POST | `/api/billing/portal` | Customer Portal |
| GET | `/api/billing/plan` | プラン状態 |
| GET | `/api/billing/transactions` | 支払い履歴 |
| POST | `/api/billing/webhook` | Stripe webhook |

### マーケット

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/market/checkout` | コンテンツ購入 `{ postId, amount, title? }` |

---

## 17. Vault（E2EE）

[../e2ee.md](../e2ee.md) を参照。サーバーはラップ済み鍵のみを保存します。

| エンドポイント | 説明 |
|---|---|
| `GET /api/vault/keys` | エンベロープ取得 |
| `POST /api/vault/keys` | 有効化 |
| `PUT /api/vault/keys` | ローテーション（`vk_version` 必須） |
| `POST /api/vault/keys/revoke-device` | デバイス失効 |
| `GET /api/vault/devices` | デバイス一覧 |
| `POST /api/vault/devices` | ペアリング開始 |
| `GET /api/vault/devices/:id` | ペアリング状態 |
| `POST /api/vault/devices/:id/approve` | ペアリング承認 |
| `DELETE /api/vault/devices/:id` | デバイス削除 |
| `GET /api/vault/items` | アイテム一覧 |
| `PUT /api/vault/items/:id` | アイテム更新 |
| `DELETE /api/vault/items/:id` | アイテム削除 |
| `DELETE /api/vault/items` | 全削除 |

---

## 18. 管理

`ADMIN_USERNAMES` で指定された管理者のみ。

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/admin/access` | 管理者チェック |
| GET | `/api/admin/analytics` | 分析 |
| GET | `/api/admin/alerts` | モデレーションアラート |
| POST | `/api/admin/alerts/:id/resolve` | 解決 |
| GET | `/api/admin/posts/hidden` | 非表示投稿 |
| POST | `/api/admin/posts/:id/hide` | 非表示 |
| POST | `/api/admin/posts/:id/unhide` | 表示 |
| POST | `/api/admin/posts/:id/nsfw` | NSFW 付与 |
| GET | `/api/admin/users` | ユーザー一覧 |
| POST | `/api/admin/users/:id/freeze` | 凍結 |
| POST | `/api/admin/users/:id/unfreeze` | 解除 |
| DELETE | `/api/admin/users/:id` | 削除 |
| GET | `/api/admin/counter/pending` | 承認待ちカウンター |
| POST | `/api/admin/counter/:id/reject` | 却下 |
| GET | `/api/admin/auth-migration` | SRP 移行状況 |
| POST | `/api/admin/rescreen-quarantined` | 再スクリーニング |
| GET/POST/DELETE | `/api/admin/file-blocklist[/:id]` | ファイルブロックリスト |
| POST | `/api/admin/backfill-embeddings` | 埋め込みバックフィル |
| POST | `/api/admin/backfill-nsfw` | NSFW バックフィル |
| POST | `/api/admin/backfill-game-descriptions` | ゲーム説明バックフィル |

---

## 19. その他

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/link-preview` | OGP 取得 `{ url }` |
| POST | `/api/report` | 通報 |
| POST | `/api/bug-reports` | GitHub Issue として公開バグ報告 |
| GET | `/api/recommendations/profile-sources` | 推薦プロファイルソース |
| GET | `/sitemap.xml` | サイトマップ |
| GET | `/api/avatar/:userId` | アバター |
| GET | `/api/nodeinfo/2.1` | NodeInfo |
| GET | `/.well-known/nodeinfo` | NodeInfo ディスカバリ |

### テスト用（`ENVIRONMENT=test` のみ）

`/api/test/*` — データシード・リセット。本番では無効。

---

## 20. レート制限

| 対象 | 制限 |
|---|---|
| ルーム作成 | 10回/分（ユーザー）、30回/分（IP） |
| スコア投稿 | 30回/分、100件/日（ユーザー×ゲーム） |
| マッチメイク | 30回/分 |
| チャット | 30回/分 |
| プッシュ登録 | 60回/分 |
| バグ報告 | 3件/日（UTC） |
