# How to Use Multiplayer in Your Flaxia Game

You only need to know two things to add multiplayer to your sandbox game:

1. Load the SDK
2. Call `client.on(...)` and `client.sendPeerData(...)`

Everything else—WebSocket, WebRTC, reconnection, fallback—the platform handles for you.

---

## 1. Load the SDK

Add this **one line** to your HTML:

```html
<script src="/sdk/multiplayer.js"></script>
```

That's it. Now `window.FlaxiaMultiplayer.MultiplayerClient` is available.

---

## 2. Minimal Working Example

You can copy-paste this and it works:

```html
<script src="/sdk/multiplayer.js"></script>
<script>
const { MultiplayerClient } = FlaxiaMultiplayer;

const client = new MultiplayerClient({ gameId: 'my-game' });

client.on('onRoomState', (state) => {
  console.log('Players:', state.players.length);
  document.getElementById('status').textContent =
    `Room: ${state.room.roomId} (${state.players.length}/2)`;
});

client.on('onPeerData', (event) => {
  console.log('Received from peer:', event.data);
  document.getElementById('peer-data').textContent = JSON.stringify(event.data);
});

// Send data to the other player at any time
function send(data) {
  client.sendPeerData(data);
}
</script>
```

---

## 3. Lifecycle (Only 4 Steps)

| Step | When | What to do |
|---|---|---|
| **Create client** | On page load | `new MultiplayerClient({ gameId })` — auto-connects |
| **Join room** | Automatically | You're in a room. Share `client.currentRoomId` to invite. |
| **Play** | Game running | `sendPeerData()` any JSON back and forth |
| **Disconnect** | Game over | No cleanup needed (closing the tab disconnects) |

---

## 4. All Events

```typescript
onRoomState(state)       // Room info + player list
onPlayerJoined(player)   // Someone joined
onPlayerLeft(userId)     // Someone left
onPlayerReady(uid, bool) // Player toggled ready
onGameStart()            // Host started the game
onGameState(event)       // Server-authoritative state update
onPlayerInput(event)     // Other player's input (for server-auth games)
onGameOver(event)        // Winner / scores
onHostChanged(newHost)   // Host migrated
onChat(event)            // Chat message
onError(error)           // Something went wrong
onDisconnect()           // Disconnected from room
onP2PState(event)        // P2P connected / disconnected / failed
onPeerData(event)        // Data from other player (P2P or fallback)
```

---

## 5. P2P? What Do I Need to Know?

**Nothing.** `sendPeerData()` sends data; `onPeerData` receives it. The SDK automatically:

1. Tries WebRTC P2P (low latency)
2. Falls back to server relay if P2P fails (slower but works everywhere)

If you want to show connection quality, listen to `onP2PState`:

```typescript
client.on('onP2PState', (event) => {
  if (event.state === 'connected') {
    // P2P is active — lowest latency
  } else {
    // Falling back to server relay — higher latency
  }
});
```

---

## 6. Two Common Patterns

### Turn-based (e.g., chess, tic-tac-toe)

```typescript
const client = new MultiplayerClient({ gameId: 'chess' });

client.on('onPeerData', (event) => {
  applyMove(event.data);
});

function makeMove(from, to) {
  client.sendPeerData({ from, to });
}
```

### Real-time (e.g., platformer, shooter)

```typescript
const client = new MultiplayerClient({ gameId: 'platformer' });

function gameLoop() {
  client.sendInput({ keys: pressedKeys, x: player.x, y: player.y });
  requestAnimationFrame(gameLoop);
}

client.on('onPlayerInput', (event) => {
  updateRemotePlayer(event.userId, event.input);
});
```

---

## 7. Pitfalls

| Pitfall | Why | Fix |
|---|---|---|
| Events don't fire | origin mismatch | Make sure your game is on `flaxia.app` (or adjust `allowedOrigins`) |
| `sendPeerData()` silently drops | not connected yet | Check `client.isConnected` before sending, or buffer until `onRoomState` fires |
| Room never gets second player | wrong roomId | The other player must use the **exact same** roomId from `client.currentRoomId` |
| Game start fails | only 1 player | `startGame()` requires ≥2 players in the room |

---

That's it. If you can write `sendPeerData()` and `on('onPeerData', ...)`, you have multiplayer. The rest is your game logic.
