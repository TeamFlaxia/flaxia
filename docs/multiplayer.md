# Flaxia Multiplayer SDK

## 概要

Flaxia のマルチプレイヤーシステムは、サンドボックス内の HTML5 ゲームにリアルタイム・ターン制・非対称のマルチプレイヤー機能を提供します。

```
 [Game Iframe]              [Game Iframe]
   @flaxia/multiplayer        @flaxia/multiplayer
     |  postMessage ↑↓            ↑↓ postMessage
     v                            v
 [Flaxia Parent]              [Flaxia Parent]
   MultiplayerManager           MultiplayerManager
     |-- WebSocket (signal) ──→ DO ←── WebSocket (signal)
     |-- RTCPeerConnection ←─── P2P DataChannel ───→
     |                          |
     |-- DO relay (fallback) ──→ DO ──→ (fallback)
```

**通信経路:**
- **コントロール**: マッチメイク、ルーム管理、シグナリング → Durable Object (WebSocket)
- **ゲームデータ**: P2P DataChannel 優先、接続断時は DO 経由に自動フォールバック
- **フレーム間**: すべて親フレーム経由 (`postMessage`)、サンドボックスゲームは直接 WebSocket/WebRTC に触らない

---

## クイックスタート

### npm パッケージとして使用

```bash
npm install @flaxia/multiplayer
```

```typescript
import { MultiplayerClient } from '@flaxia/multiplayer';

const client = new MultiplayerClient({
  gameId: 'my-game',
  autoConnect: true,
});

client.on('onRoomState', (state) => {
  console.log('Players in room:', state.players);
});

client.on('onError', (error) => {
  console.error('Multiplayer error:', error.code, error.message);
});
```

### IIFE (サンドボックスワーカー経由)

サンドボックスゲームからは sandbox オリジンのスクリプトとして読み込みます:

```html
<script src="/sdk/multiplayer.js"></script>
<script>
const client = new FlaxiaMultiplayer.MultiplayerClient({
  gameId: 'my-game',
  autoConnect: true,
});
</script>
```

---

## API リファレンス

### MultiplayerClientOptions

```typescript
interface MultiplayerClientOptions {
  /** ゲーム識別子（必須） */
  gameId: string;
  /** 参加するルームID（省略時は新規ルーム作成） */
  roomId?: string;
  /** インスタンス生成時に自動接続（デフォルト: true） */
  autoConnect?: boolean;
  /** 許可する送信元オリジン（デフォルト: flaxia.app 系） */
  allowedOrigins?: string[];
}
```

### 接続管理

```typescript
// 明示的に接続（autoConnect: false の場合）
client.connect(roomId?: string);

// 切断
client.disconnect();

// 状態確認
client.isConnected;   // boolean
client.currentRoomId; // string | null
```

### ゲーム操作

```typescript
// 入力送信（サーバー権威 or P2P 転送）
client.sendInput({ key: 'ArrowLeft', held: true });

// ゲーム開始（ホストのみ有効、2人以上必要）
client.startGame();

// 準備状態
client.setReady(true);   // 準備OK
client.setReady(false);  // 準備取消

// チャット送信
client.sendChat('Hello!');

// 状態リクエスト（再接続時など）
client.requestState();
```

### P2P データ通信

```typescript
// P2P データチャネルに任意のデータを送信
// P2P 未接続時は DO 経由で自動フォールバック
client.sendPeerData({ type: 'bullet', x: 100, y: 200 });
```

### イベント

```typescript
client.on('onRoomState', (state: RoomState) => {
  // ルーム情報 + プレイヤー一覧
  console.log(state.room, state.players);
});

client.on('onPlayerJoined', (player: PlayerInfo) => {
  console.log(`${player.username} joined`);
});

client.on('onPlayerLeft', (userId: string) => {
  console.log('Player left:', userId);
});

client.on('onPlayerReady', (userId: string, ready: boolean) => {
  console.log(userId, ready ? 'ready' : 'not ready');
});

client.on('onGameStart', () => {
  console.log('Game started!');
});

client.on('onGameState', (event: GameStateEvent) => {
  // サーバーからの権威状態更新
  console.log('State:', event.state);
});

client.on('onPlayerInput', (event: PlayerInputEvent) => {
  // 他のプレイヤーの入力
  console.log(event.userId, event.input);
});

client.on('onGameOver', (event: GameOverEvent) => {
  console.log('Winner:', event.winner);
  console.log('Scores:', event.scores);
});

client.on('onHostChanged', (newHostId: string) => {
  console.log('New host:', newHostId);
});

client.on('onChat', (event: ChatEvent) => {
  console.log(`${event.username}: ${event.message}`);
});

client.on('onError', (error: MultiplayerError) => {
  console.error(`[${error.code}] ${error.message}`);
});

client.on('onDisconnect', () => {
  console.log('Disconnected from room');
});

// === P2P イベント ===

client.on('onP2PState', (event: P2PStateEvent) => {
  if (event.state === 'connected') {
    console.log('P2P connected to peer');
  } else if (event.state === 'disconnected') {
    console.log('P2P disconnected (falling back to server relay)');
  }
});

client.on('onPeerData', (event: PeerDataEvent) => {
  // 他のプレイヤーからの P2P/フォールバックデータ
  console.log('Peer data:', event.data);
});
```

### 全イベント一覧

| イベント | ハンドラ型 | 説明 |
|---|---|---|
| `onRoomState` | `(state: RoomState) => void` | ルーム情報 + プレイヤー一覧 |
| `onPlayerJoined` | `(player: PlayerInfo) => void` | 新規プレイヤー参加 |
| `onPlayerLeft` | `(userId: string) => void` | プレイヤー退出 |
| `onPlayerReady` | `(userId: string, ready: boolean) => void` | 準備状態変更 |
| `onGameStart` | `() => void` | ゲーム開始 |
| `onGameState` | `(event: GameStateEvent) => void` | サーバー権威状態更新 |
| `onPlayerInput` | `(event: PlayerInputEvent) => void` | 他プレイヤーの入力 |
| `onGameOver` | `(event: GameOverEvent) => void` | ゲーム終了 |
| `onHostChanged` | `(newHostId: string) => void` | ホスト移行 |
| `onChat` | `(event: ChatEvent) => void` | チャットメッセージ |
| `onError` | `(error: MultiplayerError) => void` | エラー通知 |
| `onDisconnect` | `() => void` | 切断 |
| `onP2PState` | `(event: P2PStateEvent) => void` | P2P 接続状態変更 |
| `onPeerData` | `(event: PeerDataEvent) => void` | ピアからのデータ受信 |

---

## 型定義

```typescript
interface PlayerInfo {
  userId: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
  isReady: boolean;
  isHost: boolean;
}

interface RoomInfo {
  roomId: string;
  gameId: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'finished';
  maxPlayers: number;
  isPublic: boolean;
  createdAt: number;
}

interface RoomState {
  room: RoomInfo;
  players: PlayerInfo[];
}

type RoomStatus = 'lobby' | 'playing' | 'finished';

interface GameStateEvent {
  gameId: string;
  state: unknown;
  timestamp: number;
}

interface PlayerInputEvent {
  userId: string;
  input: unknown;
}

interface ChatEvent {
  userId: string;
  username: string;
  message: string;
}

interface GameOverEvent {
  winner?: string;
  scores?: Record<string, number>;
}

interface MultiplayerError {
  code: string;
  message: string;
}

interface P2PStateEvent {
  state: 'connected' | 'disconnected' | 'failed';
  peerId?: string;
}

interface PeerDataEvent {
  data: unknown;
}
```

---

## WebRTC P2P

2人目のプレイヤーが参加すると自動的に P2P 接続が開始されます。

### シグナリングフロー

```
Player A (host)              DO WebSocket              Player B
   |--- signal(offer) ------>|---- signal(offer) ------>|
   |<-- signal(answer) ------|<---- signal(answer) -----|
   |<== ICE candidates ====> |<=== ICE candidates =====>|
   |                         |                          |
   [P2P DataChannel open]    |    [P2P DataChannel open]
   sendPeerData() ────────────── P2P ────────────→ onPeerData
   sendPeerData() ───────────────────────────────→ onPeerData
```

### フォールバック動作

P2P 接続が確立できない場合や切断された場合、`sendPeerData()` は自動的に DO (サーバーリレー) 経由に切り替わります。ゲーム側で意識する必要はありません。

**エラーコード例:**
| コード | 意味 |
|---|---|
| `DISCONNECTED` | WebSocket 切断 |
| `CONNECTION_ERROR` | WebSocket 接続エラー |
| `ROOM_FULL` | ルーム定員超過 |
| `ROOM_CLOSED` | ホストによるルーム閉鎖 |
| `ROOM_TIMEOUT` | 長時間操作なしによるタイムアウト |

---

## サンプルコード

### 最小構成 (ターン制ゲーム)

```typescript
import { MultiplayerClient } from '@flaxia/multiplayer';

const client = new MultiplayerClient({ gameId: 'tic-tac-toe' });

client.on('onRoomState', (state) => {
  updateUI(state.room, state.players);
});

client.on('onPeerData', (event) => {
  // 相手の着手を受信
  applyMove(event.data as { x: number; y: number });
});

function onCellClick(x: number, y: number) {
  client.sendPeerData({ x, y });
}
```

### リアルタイムアクションゲーム

```typescript
const client = new MultiplayerClient({ gameId: 'space-shooter' });

// 毎フレーム入力送信
function gameLoop() {
  const input = gatherInput();
  client.sendInput(input);
  requestAnimationFrame(gameLoop);
}

// 他プレイヤーの入力受信
client.on('onPlayerInput', (event) => {
  updateRemotePlayer(event.userId, event.input);
});
```

### 完全なサンプル: じゃんけん

```typescript
import { MultiplayerClient, RoomState, GameOverEvent } from '@flaxia/multiplayer';

const client = new MultiplayerClient({ gameId: 'rps', autoConnect: true });

client.on('onRoomState', (state: RoomState) => {
  document.getElementById('status')!.textContent =
    `Room: ${state.room.roomId} | Players: ${state.players.length}/${state.room.maxPlayers}`;
});

client.on('onGameStart', () => {
  document.getElementById('choices')!.style.display = 'block';
});

client.on('onPeerData', (event) => {
  const data = event.data as { move: string };
  showOpponentMove(data.move);
});

client.on('onGameOver', (event: GameOverEvent) => {
  const result = event.winner
    ? event.winner === client.currentRoomId ? 'You win!' : 'You lose!'
    : 'Draw!';
  document.getElementById('result')!.textContent = result;
});

function choose(move: string) {
  client.sendPeerData({ move });
  document.getElementById('choices')!.style.display = 'none';
}

// 2人揃ったらホストがゲーム開始
client.on('onPlayerJoined', () => {
  if (client.isConnected) {
    client.startGame();
  }
});
```

---

## 内部アーキテクチャ

```
[Game Iframe]
  @flaxia/multiplayer SDK
    |
    | postMessage
    v
[Flaxia Parent Frame]
  SandboxFrame.ts
    |
    ├── joinOrCreateRoom() ──→ HTTP REST API ──→ D1 + DO
    |
    └── MultiplayerManager
          |
          ├── WebSocket (コントロール + シグナリング + フォールバック)
          ├── RTCPeerConnection (ゲームデータ: P2P優先)
          |
          v
    [Durable Object: MultiplayerRoom]
      ├── ルーム状態管理
      ├── メッセージブロードキャスト
      ├── シグナリング中継
      ├── タイムアウトアラーム
      └── ホスト移行
```

**主要コンポーネント:**
- **SDK (`@flaxia/multiplayer`)**: サンドボックスゲームに組み込むライブラリ。`postMessage` で親フレームと通信。
- **SandboxFrame.ts**: ゲーム iframe のライフサイクル管理 + REST API 呼び出し。
- **MultiplayerManager**: 親フレームで動作。WebSocket ↔ WebRTC ↔ postMessage の中継ハブ。
- **MultiplayerRoom DO**: サーバー権威型ゲームルーム。Durable Object 上で動作。
- **Matchmaker DO**: プレイヤーマッチングキュー。

---

## 制限事項

- 現在の最大プレイヤー数: **2人** (将来的に拡張予定)
- P2P は Google STUN のみ (`stun:stun.l.google.com:19302`)、TURN 未サポート
- P2P が NAT を超えられない場合は DO リレー (サーバー中継) にフォールバック
- SDK は ESM モジュールとして提供。IIFE ビルドは sandbox worker 経由で配信
