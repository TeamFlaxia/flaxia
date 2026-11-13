# Flaxia Game SDK

`@flaxia/game-sdk` は、Flaxia サンドボックスで動くゲームのための薄いラッパーです。
`postMessage` の型付きフレームを隠し、マルチプレイ・スコア・フルスクリーン・
Fresh を数行で使えるようにします。

> 契約そのものは [Game API](game-api.md) を参照してください。

---

## 読み込み方

### A. サンドボックスの IIFE を読み込む（推奨・ simplest）

HTML の先頭に **1行** 追加します。

```html
<script src="/sdk/game.js"></script>
<script>
  const { FlaxiaGame } = FlaxiaGame;
  const game = new FlaxiaGame({ gameId: 'my-game' });
</script>
```

`FlaxiaGame` グローバルから `FlaxiaGame` / `MultiplayerClient` / 型が使えます。
スクリプトは `sandbox.flaxia.app` から配信されます。

### B. npm パッケージとして使う

```bash
npm install @flaxia/game-sdk
```

```typescript
import { FlaxiaGame } from '@flaxia/game-sdk';

const game = new FlaxiaGame({ gameId: 'my-game' });
```

バンドラが `window` を参照するため、ブラウザ環境でのみ動作します。

---

## クイックスタート

```html
<script src="/sdk/game.js"></script>
<script>
  const { FlaxiaGame } = window.FlaxiaGame;

  const game = new FlaxiaGame({ gameId: 'my-game' });

  // プラットフォーム機能
  document.getElementById('fs').addEventListener('click', () => game.requestFullscreen());
  document.getElementById('fresh').addEventListener('click', () => game.requestFresh());
  document.getElementById('score').addEventListener('click', () => game.submitScore(100, 'Clear'));

  game.on('fullscreen', (granted) => console.log('fullscreen:', granted));
  game.on('scoreSubmitted', (e) => console.log('score saved:', e.score));

  // マルチプレイ
  game.multiplayer.on('onRoomState', (state) => {
    console.log('room', state.room.roomId, state.players.length);
  });
  game.multiplayer.on('onPeerData', (event) => applyPeerMove(event.data));
</script>
```

---

## `FlaxiaGame` API

### コンストラクタ

```typescript
interface FlaxiaGameOptions {
  gameId: string;            // 必須。128文字以下
  roomId?: string;           // 指定時は既存ルームに参加
  autoConnect?: boolean;     // 既定 true。false なら game.multiplayer.connect() を手動で
  allowedOrigins?: string[]; // 既定 ['https://flaxia.app', 'https://*.flaxia.app']
}

const game = new FlaxiaGame(options);
```

`gameId` が空文字・未指定だと `Error` を投げます。

### メソッド

| メソッド | 説明 |
|---|---|
| `requestFullscreen()` | フルスクリーン要求。結果は `on('fullscreen')` |
| `requestFresh()` | この投稿に Fresh する。結果は `on('fresh')` |
| `requestIdentity()` | プレイヤー情報を要求。結果は `on('identity')` |
| `createTitle(definition)` | ゲーム独自の称号を登録。結果は `on('titleCreated')` |
| `awardTitle(definition)` | 称号を作成（未登録なら）して本人に付与。結果は `on('titleAwarded')` |
| `submitScore(score, label?)` | スコア報告。`label` 既定 `''`。非有限数は破棄 |
| `sendMessage(message)` | 任意の Game API フレームを送信（検証済み） |
| `on(event, handler)` | プラットフォームイベント登録 |
| `destroy()` | リスナー解除 + マルチプレイ切断。冪等 |

### ゲッター

| ゲッター | 説明 |
|---|---|
| `game.gameId` | ゲームID |
| `game.multiplayer` | 同梱の `MultiplayerClient` |
| `game.isConnected` | マルチプレイ接続中か |
| `game.currentRoomId` | 参加中のルームID（未参加は `null`） |

### プラットフォームイベント

```typescript
interface FlaxiaGameEventMap {
  fullscreen: (granted: boolean) => void;
  fresh: (granted: boolean) => void;
  scoreSubmitted: (event: { score: number; label: string }) => void;
  identity: (identity: PlayerIdentity) => void;
  titleCreated: (event: { titleId: string }) => void;
  titleAwarded: (event: { titleId: string }) => void;
  titleError: (event: { code: string; message: string; titleId?: string }) => void;
  message: (message: ParentToGameMessage) => void; // 全フレームを受信
}
```

`message` は生のフレームを受け取りたい場合に使います（マルチプレイのイベントは
`game.multiplayer.on(...)` で受け取るのが一般的です）。

### 称号（バッジ）

```typescript
interface GameTitleDefinition {
  id: string;            // ゲーム内で一意。`<gameId>.level1` を推奨
  name: string;          // 64文字まで
  nameJa?: string;       // 64文字まで
  description?: string;  // 200文字まで
  descriptionJa?: string;
  icon?: string;         // 同一オリジンのパスのみ
}

game.on('identity', (identity) => {
  console.log(identity.username, identity.equippedTitle?.name);
});
game.requestIdentity();

game.on('titleAwarded', ({ titleId }) => console.log('awarded', titleId));
game.on('titleError', ({ code, message }) => console.warn(code, message));

game.awardTitle({ id: 'mygame.level1', name: 'Level 1 Clear', description: 'Cleared level 1.' });
```

称号はそのゲーム専用です。プラットフォームや他ゲームの称号IDを指定すると
`TITLE_CONFLICT` で拒否されます。付与してもプレイヤーの装備は変わりません。

---

## マルチプレイ

`game.multiplayer` は `MultiplayerClient` です。詳細は
[../multiplayer.md](../multiplayer.md) / [../how-to-use-multiplayer.md](../how-to-use-multiplayer.md)
を参照してください。主要な API は次のとおりです。

| メソッド / ゲッター | 説明 |
|---|---|
| `connect(roomId?)` | 接続（`autoConnect: false` 時） |
| `disconnect()` | 切断 |
| `sendInput(input)` | 入力送信 |
| `startGame()` | ゲーム開始（ホスト） |
| `setReady(ready)` | 準備状態 |
| `sendChat(message)` | チャット |
| `requestState()` | 状態再同期 |
| `sendPeerData(data)` | P2P / リレー |
| `on(event, handler)` | イベント登録 |
| `isConnected` / `currentRoomId` | 状態 |

### マルチプレイイベント

```
onRoomState(state)       onPlayerJoined(player)   onPlayerLeft(userId)
onPlayerReady(uid,bool)  onGameStart()            onGameState(event)
onPlayerInput(event)     onGameOver(event)        onHostChanged(newHostId)
onChat(event)            onError(error)           onDisconnect()
onP2PState(event)        onPeerData(event)
```

---

## 型定義

```typescript
import type {
  FlaxiaGameOptions,
  FlaxiaGameEventMap,
  ScoreSubmittedEvent,
  GameTitleDefinition,
  TitleErrorEvent,
  PlayerIdentity,
  EquippedTitle,
  GameToParentMessage,
  ParentToGameMessage,
  CaptureFrame,
  PlayerInfo,
  RoomInfo,
  RoomState,
  MultiplayerClientOptions,
} from '@flaxia/game-sdk';
```

---

## ローカル開発

親オリジンが `localhost` の場合のみ、`allowedOrigins` に追加してください。

```typescript
const game = new FlaxiaGame({
  gameId: 'my-game',
  allowedOrigins: ['http://localhost:8787', 'http://localhost:3000'],
});
```

`allowedOrigins` の最初の値が `targetOrigin` になります。

---

## `@flaxia/multiplayer` からの移行

`@flaxia/multiplayer` は非推奨のエイリアスです。`@flaxia/game-sdk` に統合されました。

```diff
- import { MultiplayerClient } from '@flaxia/multiplayer';
+ import { FlaxiaGame } from '@flaxia/game-sdk';

- const client = new MultiplayerClient({ gameId: 'my-game' });
+ const game = new FlaxiaGame({ gameId: 'my-game' });
+ const client = game.multiplayer;
```

`MultiplayerClient` の API はそのまま使えます。

---

## サンプル

### ターン制（じゃんけん）

```typescript
const game = new FlaxiaGame({ gameId: 'rps' });

game.multiplayer.on('onPeerData', (event) => {
  showOpponentMove((event.data as { move: string }).move);
});

function choose(move: string) {
  game.multiplayer.sendPeerData({ move });
}
```

### リアルタイム

```typescript
const game = new FlaxiaGame({ gameId: 'platformer' });

function loop() {
  game.multiplayer.sendInput({ keys: pressedKeys, x: player.x, y: player.y });
  requestAnimationFrame(loop);
}

game.multiplayer.on('onPlayerInput', (event) => {
  updateRemotePlayer(event.userId, event.input);
});
```

### スコアとフルスクリーン

```typescript
const game = new FlaxiaGame({ gameId: 'space-shooter' });

game.on('scoreSubmitted', (e) => {
  hud.setScore(e.score);
});

function onStageClear() {
  game.submitScore(score, 'Stage 1');
  game.requestFullscreen();
}
```
