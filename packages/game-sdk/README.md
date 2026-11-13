# @flaxia/game-sdk

Flaxia サンドボックスで動くゲームのための薄いラッパーです。
`postMessage` の型付きフレームを隠し、マルチプレイ・スコア・フルスクリーン・
Fresh を数行で使えます。

> 契約は [Flaxia Game API](../../docs/developer/game-api.md)、
> 使い方は [Game SDK](../../docs/developer/sdk.md) を参照してください。

## 使い方

### サンドボックスの IIFE（推奨）

```html
<script src="/sdk/game.js"></script>
<script>
  const { FlaxiaGame } = window.FlaxiaGame;
  const game = new FlaxiaGame({ gameId: 'my-game' });

  game.on('fullscreen', (granted) => console.log(granted));
  game.multiplayer.on('onPeerData', (event) => console.log(event.data));
</script>
```

### npm

```bash
npm install @flaxia/game-sdk
```

```typescript
import { FlaxiaGame } from '@flaxia/game-sdk';

const game = new FlaxiaGame({ gameId: 'my-game' });
```

## API

| メソッド / ゲッター | 説明 |
|---|---|
| `new FlaxiaGame({ gameId, roomId?, autoConnect?, allowedOrigins? })` | 初期化 |
| `requestFullscreen()` | フルスクリーン要求 |
| `requestFresh()` | Fresh 要求 |
| `submitScore(score, label?)` | スコア報告 |
| `sendMessage(message)` | 任意の Game API フレーム |
| `on(event, handler)` | `fullscreen` / `fresh` / `scoreSubmitted` / `message` |
| `destroy()` | 片付け |
| `multiplayer` | 同梱の `MultiplayerClient` |
| `isConnected` / `currentRoomId` | マルチプレイ状態 |

## `@flaxia/multiplayer` からの移行

`@flaxia/multiplayer` は非推奨のエイリアスです。

```diff
- import { MultiplayerClient } from '@flaxia/multiplayer';
+ import { FlaxiaGame } from '@flaxia/game-sdk';

- const client = new MultiplayerClient({ gameId: 'my-game' });
+ const game = new FlaxiaGame({ gameId: 'my-game' });
+ const client = game.multiplayer;
```

## 開発

```bash
npm run build:game-sdk   # vite build + embed
npm test                 # tests/game-sdk.test.ts
```
