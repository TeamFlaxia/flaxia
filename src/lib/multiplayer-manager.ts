type WsMessage =
  | { type: 'ready'; ready: boolean }
  | { type: 'start_game' }
  | { type: 'leave' }
  | { type: 'input'; input: unknown; timestamp: number }
  | { type: 'chat'; message: string }
  | { type: 'request_state' }
  | { type: 'signal'; targetUserId: string; signal: { type: string; payload: unknown } }
  | { type: 'peer_data'; data: unknown };

interface MultiplayerConfig {
  gameId: string;
  roomId: string;
  userId: string;
  wsUrl: string;
  iframe: HTMLIFrameElement;
  sandboxOrigin: string;
  onDisconnect?: () => void;
}

const STUN_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const WS_OPEN = 1;

export class MultiplayerManager {
  private ws: WebSocket | null = null;
  private config: MultiplayerConfig;
  private connected = false;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private p2pConnected = false;
  private peerIds: string[] = [];
  private isHost = false;

  constructor(config: MultiplayerConfig) {
    this.config = config;
  }

  connect(): void {
    if (this.connected) return;

    const wsUrl = new URL(this.config.wsUrl, globalThis.location.origin);
    wsUrl.searchParams.set('gameId', this.config.gameId);
    wsUrl.searchParams.set('roomId', this.config.roomId);

    this.ws = new WebSocket(wsUrl.toString().replace(/^http/, 'ws'));

    this.ws.addEventListener('open', () => {
      this.connected = true;
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data as string);
        this.handleWsMessage(data);
      } catch {
        // ignore invalid JSON
      }
    });

    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.relayToGame({ type: 'MULTIPLAYER_ERROR', code: 'DISCONNECTED', message: 'Connection closed' });
      this.config.onDisconnect?.();
    });

    this.ws.addEventListener('error', () => {
      this.connected = false;
      this.relayToGame({ type: 'MULTIPLAYER_ERROR', code: 'CONNECTION_ERROR', message: 'WebSocket connection error' });
    });
  }

  disconnect(): void {
    this.closeP2P();
    if (this.ws) {
      try {
        this.ws.close(1000, 'Game disconnected');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  handleGameMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'MULTIPLAYER_INPUT':
        this.sendWs({ type: 'input', input: msg.input, timestamp: Date.now() });
        break;

      case 'MULTIPLAYER_START_GAME':
        this.sendWs({ type: 'start_game' });
        break;

      case 'MULTIPLAYER_SET_READY':
        this.sendWs({ type: 'ready', ready: !!msg.ready });
        break;

      case 'MULTIPLAYER_CHAT':
        this.sendWs({ type: 'chat', message: String(msg.message || '') });
        break;

      case 'MULTIPLAYER_REQUEST_STATE':
        this.sendWs({ type: 'request_state' });
        break;

      case 'MULTIPLAYER_DISCONNECT':
        this.disconnect();
        break;

      case 'MULTIPLAYER_SEND_PEER_DATA':
        this.sendPeerData(msg.data);
        break;
    }
  }

  destroy(): void {
    this.closeP2P();
    this.disconnect();
  }

  // ===== WebRTC P2P =====

  private sendPeerData(data: unknown): void {
    if (this.p2pConnected && this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(data));
    } else {
      this.sendWs({ type: 'peer_data', data });
    }
  }

  private handleWsMessage(data: Record<string, unknown>): void {
    const msgType = data.type as string;

    if (msgType === 'signal') {
      this.handleSignal(data as { userId: string; signal: { type: string; payload: unknown } });
      return;
    }

    if (msgType === 'room_state') {
      const players = data.players as Array<Record<string, unknown>>;
      this.peerIds = players.map((p) => p.userId as string);
      this.isHost = players.some((p) => p.userId === this.config.userId && p.isHost === true);
      if (players.length >= 2 && !this.pc) {
        this.startP2P();
      }
    }

    if (msgType === 'player_joined') {
      const player = data.player as Record<string, unknown>;
      if (!this.peerIds.includes(player.userId as string)) {
        this.peerIds.push(player.userId as string);
      }
      if (this.peerIds.length >= 2 && !this.pc) {
        this.startP2P();
      }
    }

    if (msgType === 'player_left') {
      const userId = data.userId as string;
      this.peerIds = this.peerIds.filter((id) => id !== userId);
      if (this.p2pConnected && this.peerIds.length < 2) {
        this.closeP2P();
        this.sendP2PStateToGame('disconnected');
      }
    }

    if (msgType === 'peer_data') {
      this.sendPeerDataToGame(data.data);
      return;
    }

    this.relayToGame(data);
  }

  private startP2P(): void {
    if (this.pc) return;
    this.createPeerConnection();
    if (this.isHost) {
      this.createOffer();
    }
  }

  private createPeerConnection(): void {
    if (typeof RTCPeerConnection === 'undefined') return;
    this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal('ice-candidate', event.candidate);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc?.iceConnectionState === 'disconnected' || this.pc?.iceConnectionState === 'failed') {
        this.onP2PDisconnected();
      }
    };

    this.pc.ondatachannel = (event) => {
      this.setupDataChannel(event.channel);
    };

    const channel = this.pc.createDataChannel('game');
    this.setupDataChannel(channel);
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    this.dataChannel.onopen = () => {
      this.p2pConnected = true;
      this.sendP2PStateToGame('connected');
    };
    this.dataChannel.onclose = () => {
      this.onP2PDisconnected();
    };
    this.dataChannel.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        this.sendPeerDataToGame(parsed);
      } catch {
        // ignore invalid JSON
      }
    };
  }

  private async createOffer(): Promise<void> {
    if (!this.pc) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal('offer', offer);
    } catch {
      // ignore
    }
  }

  private async handleSignal(data: { userId: string; signal: { type: string; payload: unknown } }): Promise<void> {
    if (!this.pc) {
      this.createPeerConnection();
    }
    if (!this.pc) return;

    try {
      switch (data.signal.type) {
        case 'offer':
          await this.pc.setRemoteDescription(
            new RTCSessionDescription(data.signal.payload as RTCSessionDescriptionInit),
          );
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.sendSignal('answer', answer);
          break;

        case 'answer':
          await this.pc.setRemoteDescription(
            new RTCSessionDescription(data.signal.payload as RTCSessionDescriptionInit),
          );
          break;

        case 'ice-candidate':
          await this.pc.addIceCandidate(new RTCIceCandidate(data.signal.payload as RTCIceCandidateInit));
          break;
      }
    } catch {
      // ignore invalid signal
    }
  }

  private sendSignal(type: string, payload: unknown): void {
    const peerId = this.peerIds.find((id) => id !== this.config.userId);
    if (peerId) {
      this.sendWs({ type: 'signal', targetUserId: peerId, signal: { type, payload } });
    }
  }

  private onP2PDisconnected(): void {
    this.p2pConnected = false;
    this.dataChannel = null;
    this.pc = null;
    this.sendP2PStateToGame('disconnected');
  }

  private closeP2P(): void {
    this.p2pConnected = false;
    try {
      this.dataChannel?.close();
    } catch {
      // ignore
    }
    this.dataChannel = null;
    try {
      this.pc?.close();
    } catch {
      // ignore
    }
    this.pc = null;
  }

  // ===== Message relaying =====

  private relayToGame(data: Record<string, unknown>): void {
    const msgType = data.type as string;
    let parentMsg: Record<string, unknown> | null = null;

    switch (msgType) {
      case 'room_state':
        parentMsg = {
          type: 'MULTIPLAYER_ROOM_STATE',
          room: data.room,
          players: data.players,
        };
        break;

      case 'player_joined':
        parentMsg = { type: 'MULTIPLAYER_PLAYER_JOINED', player: data.player };
        break;

      case 'player_left':
        parentMsg = { type: 'MULTIPLAYER_PLAYER_LEFT', userId: data.userId };
        break;

      case 'player_ready':
        parentMsg = { type: 'MULTIPLAYER_PLAYER_READY', userId: data.userId, ready: data.ready };
        break;

      case 'game_start':
        parentMsg = { type: 'MULTIPLAYER_GAME_START' };
        break;

      case 'game_state':
        parentMsg = {
          type: 'MULTIPLAYER_STATE',
          gameId: this.config.gameId,
          state: data.state,
          timestamp: data.timestamp,
        };
        break;

      case 'player_input':
        parentMsg = { type: 'MULTIPLAYER_PLAYER_INPUT', userId: data.userId, input: data.input };
        break;

      case 'game_over':
        parentMsg = {
          type: 'MULTIPLAYER_GAME_OVER',
          winner: data.winner,
          scores: data.scores,
        };
        break;

      case 'host_changed':
        parentMsg = { type: 'MULTIPLAYER_HOST_CHANGED', newHostId: data.newHostId };
        break;

      case 'chat':
        parentMsg = {
          type: 'MULTIPLAYER_CHAT',
          userId: data.userId,
          username: data.username,
          message: data.message,
        };
        break;

      case 'error':
        parentMsg = { type: 'MULTIPLAYER_ERROR', code: data.code, message: data.message };
        break;
    }

    if (parentMsg) {
      try {
        this.config.iframe.contentWindow?.postMessage(parentMsg, this.config.sandboxOrigin);
      } catch {
        // ignore
      }
    }
  }

  private sendP2PStateToGame(state: 'connected' | 'disconnected' | 'failed'): void {
    try {
      this.config.iframe.contentWindow?.postMessage(
        { type: 'MULTIPLAYER_P2P_STATE', state },
        this.config.sandboxOrigin,
      );
    } catch {
      // ignore
    }
  }

  private sendPeerDataToGame(data: unknown): void {
    try {
      this.config.iframe.contentWindow?.postMessage({ type: 'MULTIPLAYER_PEER_DATA', data }, this.config.sandboxOrigin);
    } catch {
      // ignore
    }
  }

  private sendWs(msg: WsMessage): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
