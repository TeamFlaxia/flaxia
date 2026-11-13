# Flaxia Game API

サンドボックスで実行される Flaxia ゲームが使える **API 契約** です。
ゲームからメインオリジン（`flaxia.app`）へ直接アクセスすることはできません。
すべてのケーパビリティは、型付き `postMessage` フレームとして提供されます。

この文書は仕様書です。実装は次の2か所です。

| 側 | ファイル | 役割 |
|---|---|---|
| ゲーム側 | `packages/game-sdk/src/protocol.ts` | フレームの型と実行時バリデータ |
| 親側 | `src/lib/bridge.ts` | フレームの型と実行時バリデータ |

両者は `tests/game-sdk-protocol-sync.test.ts` で同期が保証されています。

---

## 1. 実行環境

```
flaxia.app（メイン）                      sandbox.flaxia.app
┌──────────────────────────────────┐     ┌────────────────────────────┐
│ PostCard / ArcadePage            │     │ WVFS ゲームドキュメント      │
│  ┌────────────────────────────┐  │     │ ┌────────────────────────┐ │
│  │ <iframe sandbox>           │◄─┼─────┼─┤ ゲーム（あなたのコード） │ │
│  │  allow-scripts             │  │post │ │  Flaxia Game SDK       │ │
│  │  allow-pointer-lock        │◄─┼─────┼─┤  /sdk/game.js          │ │
│  │  allow-forms allow-popups  │  │Message└────────────────────────┘ │
│  │  ※ allow-same-origin 禁止  │  │     └────────────────────────────┘
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

- ゲームドキュメントは **opaque origin**（`event.origin === 'null'`）で実行されます。
- したがって `window.parent` しか通信相手がおらず、`localStorage`・Cookie・
  `fetch` はメインオリジンには届きません（WVFS が互換シムを注入します）。
- `allow-same-origin` は全 iframe で恒久的に禁止です。

---

## 2. ライフサイクル

```
ゲーム読み込み
   │
   ├─ new FlaxiaGame({ gameId })        ← SDK 初期化（マルチプレイ自動接続）
   │
   ├─ on('onRoomState')                 ← ルーム入室がわかる
   │
   ├─ プレイ                            ← sendInput / sendPeerData / submitScore ...
   │
   └─ destroy()                         ← 片付け（iframe 破棄時は自動）
```

`gameId` は **128文字以下の任意の文字列** で、同じゲームを一意に特定できるものを
選んでください（例: パッケージ名、スラグ）。投稿ID（postId）ではありません。

---

## 3. トランスポートルール

1. フレームはすべて `window.parent.postMessage(message, targetOrigin)` で送ります。
2. `targetOrigin` は `https://flaxia.app`（ローカル開発時は `http://localhost:*`）。
   `'*'` は使わないでください。
3. 受信時は `event.origin` を検証します（SDK が自動で行います）。
4. すべてのフレームは `type` を持ち、ペイロード（payload）は JSON 化可能です。
5. ゲームは **WebSocket / WebRTC を直接扱いません**。親が中継します。

---

## 4. ケーパビリティ

### 4.1 フルスクリーン

| 方向 | フレーム |
|---|---|
| ゲーム → 親 | `{ type: 'REQUEST_FULLSCREEN' }` |
| 親 → ゲーム | `{ type: 'FULLSCREEN_GRANTED' }` / `{ type: 'FULLSCREEN_DENIED' }` |

ユーザーの操作（クリック）の中で呼ぶこと。ブラウザのFullscreen APIは親が実行します。

### 4.2 Fresh（いいね）

| 方向 | フレーム |
|---|---|
| ゲーム → 親 | `{ type: 'REQUEST_FRESH' }` |
| 親 → ゲーム | `{ type: 'FRESH_GRANTED' }` / `{ type: 'FRESH_DENIED' }` |

ゲーム中の「この投稿に Fresh する」ボタン用です。

### 4.3 スコア

| 方向 | フレーム |
|---|---|
| ゲーム → 親 | `{ type: 'POST_SCORE'; score: number; label: string }` |
| 親 → ゲーム | `{ type: 'SCORE_SUBMITTED'; score: number; label: string }` |

- `score` は有限の数値（`NaN` / `Infinity` は破棄）。
- `label` は 64文字以下の文字列（オプション、既定 `''`）。
- スコアはクライアント主張値です。サーバーは 0 ≤ score ≤ 1,000,000,000 に制限し、
  1ユーザー・1ゲーム・1日 100件、60秒で 30回まで率制限をかけます。
- リーダーボードは REST API 経由で読み書きできます（[REST API](rest-api.md#11-マルチプレイ)）。

### 4.4 マルチプレイ

詳細は [../multiplayer.md](../multiplayer.md) と [Game SDK](sdk.md) を参照してください。
ゲーム側のフレームは次のとおりです。

**ゲーム → 親**

| フレーム | ペイロード | 説明 |
|---|---|---|
| `MULTIPLAYER_CONNECT` | `gameId`, `roomId?` | ルーム参加（未指定時は新規作成） |
| `MULTIPLAYER_DISCONNECT` | – | 切断 |
| `MULTIPLAYER_INPUT` | `input` | 入力（サーバー権威ゲーム用） |
| `MULTIPLAYER_START_GAME` | – | 開始（ホストのみ） |
| `MULTIPLAYER_SET_READY` | `ready: boolean` | 準備状態 |
| `MULTIPLAYER_CHAT` | `message` | チャット |
| `MULTIPLAYER_REQUEST_STATE` | – | 状態の再同期 |
| `MULTIPLAYER_SEND_PEER_DATA` | `data` | P2P / リレー |

**親 → ゲーム**

| フレーム | ペイロード | 説明 |
|---|---|---|
| `MULTIPLAYER_STATE` | `gameId`, `state`, `timestamp` | 権威状態 |
| `MULTIPLAYER_ROOM_STATE` | `room`, `players` | ルーム + 参加者 |
| `MULTIPLAYER_PLAYER_JOINED` | `player` | 参加 |
| `MULTIPLAYER_PLAYER_LEFT` | `userId` | 退出 |
| `MULTIPLAYER_PLAYER_READY` | `userId`, `ready` | 準備変更 |
| `MULTIPLAYER_GAME_START` | – | 開始 |
| `MULTIPLAYER_GAME_OVER` | `winner?`, `scores?` | 終了 |
| `MULTIPLAYER_PLAYER_INPUT` | `userId`, `input` | 他プレイヤーの入力 |
| `MULTIPLAYER_HOST_CHANGED` | `newHostId` | ホスト移行 |
| `MULTIPLAYER_ERROR` | `code`, `message` | エラー |
| `MULTIPLAYER_P2P_STATE` | `state`, `peerId?` | P2P 状態 |
| `MULTIPLAYER_PEER_DATA` | `data` | ピアからのデータ |

`MULTIPLAYER_CONNECT` / `DISCONNECT` / `INPUT` / `START_GAME` / `SET_READY` /
`CHAT` / `REQUEST_STATE` / `SEND_PEER_DATA` も親 → ゲーム方向へエコーされる
ことがあります（親の状態同期用）。

### 4.5 キャプチャ（スクリーンショット / GIF）

ゲーム側の実装は不要です。WVFS がゲーム HTML にキャプチャブリッジを注入します。
親が `CAPTURE_INIT` を送ると、ブリッジが canvas を検出して
`CAPTURE_READY` を返し、以降 `CAPTURE_FRAME` / `CAPTURE_GIF` に応答します。

| 方向 | フレーム |
|---|---|
| 親 → ゲーム | `CAPTURE_INIT` / `CAPTURE_FRAME { requestId }` / `CAPTURE_GIF { requestId }` |
| ゲーム → 親 | `CAPTURE_READY { ok }` / `CAPTURE_FRAME_RESULT { requestId, mime, data }` / `CAPTURE_GIF_RESULT { requestId, frames }` / `CAPTURE_ERROR { requestId, message }` |

### 4.6 ストレージ

WVFS が `localStorage` / `sessionStorage` の互換シムを注入します。
ゲームは通常どおり `localStorage.setItem(...)` を使えます。
保存先はブラウザローカルで、アカウント・デバイス間では同期されません。

### 4.7 バッジ（称号）

プレイヤーの称号（バッジ）を読み取り、ゲーム独自の称号を作成・付与できます。
称号はユーザー名の後ろに表示され、プレイヤーは設定画面から装備します。

**読み取り（誰がプレイしているか）**

| 方向 | フレーム |
|---|---|
| ゲーム → 親 | `{ type: 'REQUEST_IDENTITY' }` |
| 親 → ゲーム | `{ type: 'PLAYER_IDENTITY'; identity: PlayerIdentity }` |

```ts
type PlayerIdentity = {
  userId: string | null;
  username: string | null;
  displayName: string | null;
  avatarKey: string | null;
  equippedTitle: {
    id: string;
    name: string;
    nameJa: string;
    description: string;
    descriptionJa: string;
    icon: string;
  } | null;
};
```

未ログイン時はすべて `null` です。`equippedTitle` は装備中の称号がない場合も `null` です。

**作成・付与（ゲーム独自の実績）**

| 方向 | フレーム |
|---|---|
| ゲーム → 親 | `{ type: 'CREATE_TITLE'; titleId, name, nameJa?, description?, descriptionJa?, icon? }` |
| ゲーム → 親 | `{ type: 'AWARD_TITLE'; titleId, name, nameJa?, description?, descriptionJa?, icon? }` |
| 親 → ゲーム | `{ type: 'TITLE_CREATED'; titleId }` / `{ type: 'TITLE_AWARDED'; titleId }` / `{ type: 'TITLE_ERROR'; code, message, titleId? }` |

- 称号は **そのゲーム専用** です。ゲームは自分が作った称号だけを付与できます。
  プラットフォームの称号や他ゲームの称号を指定すると `TITLE_CONFLICT` で拒否されます。
- `titleId` はゲーム内で一意なら何でも構いませんが、`<gameId>.level1` のように
  ゲームIDで名前空間を切ってください（128文字まで、`A-Za-z0-9._:-`）。
- 定義は **書き込み一回限り** です（最初に登録された名前・説明・アイコンが採用されます）。
- `icon` は同一オリジンのパスのみ（例: `/icons/badge-96.png`）。省略時は既定アイコンになります。
- 付与は実行者本人に対してのみ行われ、冪等です（再付与は成功扱い）。
- 1ゲームあたり最大200件、`name` は64文字、`description` は200文字までです。
- レート制限: 作成 120回/5分、付与 300回/5分（ユーザー単位）。
- 付与してもプレイヤーの装備は変わりません。装備はプレイヤー自身が選びます。
- `AWARD_TITLE` は称号が未登録でも作成してから付与します。実績一覧を先に
  出したい場合は `CREATE_TITLE` を使ってください。

---

## 5. フレーム一覧（一覧表）

### ゲーム → 親

```
REQUEST_FULLSCREEN
REQUEST_FRESH
REQUEST_IDENTITY
CREATE_TITLE               { titleId, name, nameJa?, description?, descriptionJa?, icon? }
AWARD_TITLE                { titleId, name, nameJa?, description?, descriptionJa?, icon? }
POST_SCORE                 { score, label }
MULTIPLAYER_CONNECT        { gameId, roomId? }
MULTIPLAYER_DISCONNECT
MULTIPLAYER_INPUT          { input }
MULTIPLAYER_START_GAME
MULTIPLAYER_SET_READY      { ready }
MULTIPLAYER_CHAT           { message }
MULTIPLAYER_REQUEST_STATE
MULTIPLAYER_SEND_PEER_DATA { data }
CAPTURE_READY              { ok }
CAPTURE_FRAME_RESULT       { requestId, mime, data }
CAPTURE_GIF_RESULT         { requestId, frames }
CAPTURE_ERROR              { requestId, message }
```

### 親 → ゲーム

```
FULLSCREEN_GRANTED / FULLSCREEN_DENIED
FRESH_GRANTED / FRESH_DENIED
PLAYER_IDENTITY            { identity }
TITLE_CREATED              { titleId }
TITLE_AWARDED              { titleId }
TITLE_ERROR                { code, message, titleId? }
SCORE_SUBMITTED            { score, label }
CAPTURE_INIT
CAPTURE_FRAME              { requestId }
CAPTURE_GIF                { requestId }
MULTIPLAYER_CONNECT        { gameId, roomId? }
MULTIPLAYER_DISCONNECT
MULTIPLAYER_INPUT          { input, timestamp }
MULTIPLAYER_START_GAME
MULTIPLAYER_SET_READY      { ready }
MULTIPLAYER_CHAT           { message }
MULTIPLAYER_REQUEST_STATE
MULTIPLAYER_SEND_PEER_DATA { data }
MULTIPLAYER_STATE          { gameId, state, timestamp }
MULTIPLAYER_ROOM_STATE     { room, players }
MULTIPLAYER_PLAYER_JOINED  { player }
MULTIPLAYER_PLAYER_LEFT    { userId }
MULTIPLAYER_PLAYER_READY   { userId, ready }
MULTIPLAYER_GAME_START
MULTIPLAYER_GAME_OVER      { winner?, scores? }
MULTIPLAYER_PLAYER_INPUT   { userId, input }
MULTIPLAYER_HOST_CHANGED   { newHostId }
MULTIPLAYER_ERROR          { code, message }
MULTIPLAYER_P2P_STATE      { state, peerId? }
MULTIPLAYER_PEER_DATA      { data }
```

---

## 6. エラーコード

`MULTIPLAYER_ERROR.code` に設定されます。

| コード | 発行元 | 意味 |
|---|---|---|
| `DISCONNECTED` | 親 | WebSocket が切れた |
| `CONNECTION_ERROR` | 親 | WebSocket 接続エラー |
| `INVALID_CONFIG` | 親 | `gameId` 未提供 |
| `ROOM_JOIN_FAILED` | 親 | ルーム参加/作成に失敗 |
| `ROOM_CLOSED` | DO | ホストがルームを閉じた |
| `ROOM_TIMEOUT` | DO | 無操作によりルームが期限切れ |
| `NOT_HOST` | DO | ホスト以外がゲームを開始しようとした |
| `NOT_ENOUGH_PLAYERS` | DO | 2人未満で開始しようとした |
| `ROOM_FULL` | 旧 | ルーム定員超過（現在の DO は `ROOM_CLOSED` 等） |

`TITLE_ERROR.code` に設定されます。

| コード | 意味 |
|---|---|
| `UNAUTHENTICATED` | サインインしていない |
| `INVALID_TITLE` | `titleId` / 名前 / 説明 / アイコンの形式が不正 |
| `POST_NOT_FOUND` | 実行中のゲーム投稿が見つからない（非公開・削除済みなど） |
| `TITLE_CONFLICT` | その `titleId` は他ゲームまたはプラットフォームの称号 |
| `TITLE_LIMIT` | 1ゲームあたりの称号上限（200件）に達した |
| `RATE_LIMITED` | レート制限 |
| `NETWORK` | 親からサーバーへの通信に失敗 |
| `INTERNAL` | サーバーエラー |

---

## 7. ペイロード制限

| 項目 | 上限 |
|---|---|
| `gameId` / `roomId` | 128文字 |
| `MULTIPLAYER_CHAT.message` | 500文字 |
| `MULTIPLAYER_INPUT.input` / `MULTIPLAYER_SEND_PEER_DATA.data` | JSON 65,536 bytes |
| `POST_SCORE.score` | 0 〜 1,000,000,000 |
| `titleId` | 128文字（`A-Za-z0-9._:-`） |
| `CREATE_TITLE.name` / `AWARD_TITLE.name` | 64文字（必須） |
| `nameJa` | 64文字 |
| `description` / `descriptionJa` | 各 200文字 |
| `icon` | 512文字（同一オリジンのパス） |
| 1ゲームあたりの称号数 | 200件 |
| プレイヤー数 | 2人（最大8人まで仕様上許容） |

---

## 8. バージョニングと互換性

- フレームの `type` は **追加のみ** 変更され、既存の `type` の意味が変わることはありません。
- 新しいフィールドは省略可能として追加されます。
- `packages/game-sdk` のセマンティックバージョンと、この文書のリビジョンを対応づけます。
- プロトコルの変更は `tests/game-sdk-protocol-sync.test.ts` が検知します。

---

## 9. セキュリティ要件

- ゲームは **入力値として扱われます**。ゲームが送るフレームはすべてバリデーションされます。
- ゲームはメインオリジンの Cookie・DOM・ストレージにアクセスできません。
- ゲームはネットワークに直接アクセスできません（WVFS が提供するリソースのみ）。
- ゲーム作者は、ゲーム内でユーザーに入力を求める場合、信頼できる UI を描画してください
  （親オリジンの UIを模倣しない）。

---

## 10. 実装メモ（既知のギャップ）

現状の実装で把握されている課題です。SDK を使う上で把握しておいてください。

- `POST_SCORE` は親にトースト表示と `SCORE_SUBMITTED` 戻しまでを行いますが、
  リーダーボードへの永続化はプラットフォーム側の未接続部分があります
  （[REST API](rest-api.md#11-マルチプレイ) をサーバー側から呼ぶ形での連携が前提）。
- `REQUEST_FRESH` / `POST_SCORE` はレガシー `SandboxBridge` 経由でのみハンドルされます。
  WVFS ゲームでは `sandboxRequestFresh` / `sandboxPostScore` イベントが
  dispatch されますが、現状リスナーは未接続です。
- `REQUEST_IDENTITY` / `CREATE_TITLE` / `AWARD_TITLE` は WVFS とレガシー
  `SandboxFrame` の両方で親側に接続済みです（`src/lib/game-badge-bridge.ts`）。
  ただし SWF（Ruffle）で動くゲームと、オフライン（ダウンロード済み）ゲームでは
  まだ利用できません。
- `MULTIPLAYER_CHAT` の親 → ゲームフレームは `userId` / `username` を含みません
  （ゲーム側は `MULTIPLAYER_CHAT` に任意で含められます）。

これらの整理は [Issue](https://github.com/TeamFlaxia/flaxia/issues) で
`developer-experience` ラベルにて追跡します。
