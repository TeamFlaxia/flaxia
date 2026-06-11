import type { CallParticipant, SignalMessage } from '../types/call';

const STUN_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }],
};

export interface CallClientCallbacks {
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteStreamRemoved: () => void;
  onCallEnded: (userId: string) => void;
  onParticipantJoined: (participant: CallParticipant) => void;
  onParticipantLeft: (userId: string) => void;
  onMuteChanged: (userId: string, muted: boolean) => void;
  onParticipantsList: (participants: CallParticipant[]) => void;
  onError: (error: string) => void;
}

export interface CallClient {
  startCall(): Promise<void>;
  joinCall(): Promise<void>;
  endCall(): void;
  toggleMute(): boolean;
  setMuted(muted: boolean): void;
  toggleSpeaker(): boolean;
  getLocalStream(): MediaStream | null;
  isMuted(): boolean;
  destroy(): void;
}

export function createCallClient(
  roomId: string,
  wsUrl: string,
  currentUser: { id: string; username?: string; display_name?: string | null; avatar_key?: string | null },
  callbacks: CallClientCallbacks,
): CallClient {
  let peerConnection: RTCPeerConnection | null = null;
  let localStream: MediaStream | null = null;
  let signalingWs: WebSocket | null = null;
  let isMuted = false;
  let isSpeakerOn = false;
  let destroyed = false;

  function connectSignaling(): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        userId: currentUser.id,
        username: currentUser.username || '',
        display_name: currentUser.display_name || '',
        avatar_key: currentUser.avatar_key || '',
      });
      const url = `${wsUrl}${params.toString()}`;
      const ws = new WebSocket(url);
      signalingWs = ws;

      ws.onopen = () => {
        resolve();
      };

      ws.onmessage = (event) => {
        if (destroyed) return;
        try {
          const msg: SignalMessage = JSON.parse(event.data);
          handleSignalMessage(msg);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!destroyed) {
          callbacks.onCallEnded('');
        }
      };

      ws.onerror = () => {
        callbacks.onError('Signaling connection failed');
        reject(new Error('Signaling connection failed'));
      };
    });
  }

  async function handleSignalMessage(msg: SignalMessage): Promise<void> {
    switch (msg.type) {
      case 'participants':
        if (msg.participants) {
          callbacks.onParticipantsList(msg.participants as unknown as CallParticipant[]);
        }
        break;

      case 'join':
        if (msg.userId !== currentUser.id) {
          callbacks.onParticipantJoined({
            call_id: roomId,
            user_id: msg.userId,
            username: msg.username || '',
            display_name: msg.display_name || null,
            avatar_key: msg.avatar_key || null,
            joined_at: '',
            left_at: null,
            muted: false,
          });
        }
        break;

      case 'leave':
        if (msg.userId !== currentUser.id) {
          callbacks.onParticipantLeft(msg.userId);
        }
        break;

      case 'offer':
        if (msg.sdp && peerConnection && msg.userId !== currentUser.id) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          sendSignal({ type: 'answer', userId: currentUser.id, sdp: answer.sdp!, targetUserId: msg.userId });
        }
        break;

      case 'answer':
        if (msg.sdp && peerConnection) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
        }
        break;

      case 'ice-candidate':
        if (msg.candidate && peerConnection) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch {
            // ignore invalid candidates
          }
        }
        break;

      case 'mute':
        if (msg.userId !== currentUser.id) {
          callbacks.onMuteChanged(msg.userId, msg.muted ?? false);
        }
        break;

      case 'end-call':
        callbacks.onCallEnded(msg.userId);
        break;
    }
  }

  function sendSignal(msg: SignalMessage): void {
    if (signalingWs && signalingWs.readyState === WebSocket.OPEN) {
      signalingWs.send(JSON.stringify(msg));
    }
  }

  async function createPeerConnection(): Promise<void> {
    peerConnection = new RTCPeerConnection(STUN_SERVERS);

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: 'ice-candidate',
          userId: currentUser.id,
          candidate: event.candidate.toJSON(),
          targetUserId: '',
        });
      }
    };

    peerConnection.ontrack = (event) => {
      if (event.streams[0]) {
        callbacks.onRemoteStream(event.streams[0]);
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection?.connectionState === 'disconnected' || peerConnection?.connectionState === 'failed') {
        callbacks.onCallEnded('');
      }
    };

    if (localStream) {
      for (const track of localStream.getTracks()) {
        peerConnection.addTrack(track, localStream);
      }
    }
  }

  async function startCall(): Promise<void> {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      callbacks.onError('Microphone access denied');
      return;
    }

    await connectSignaling();
    await createPeerConnection();

    const offer = await peerConnection!.createOffer();
    await peerConnection!.setLocalDescription(offer);
    sendSignal({ type: 'offer', userId: currentUser.id, sdp: offer.sdp! });
  }

  async function joinCall(): Promise<void> {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      callbacks.onError('Microphone access denied');
      return;
    }

    await connectSignaling();
    await createPeerConnection();
  }

  function endCall(): void {
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => {
        t.stop();
      });
      localStream = null;
    }
    sendSignal({ type: 'leave', userId: currentUser.id });
    if (signalingWs) {
      signalingWs.close();
      signalingWs = null;
    }
    callbacks.onRemoteStreamRemoved();
  }

  function toggleMute(): boolean {
    isMuted = !isMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => {
        t.enabled = !isMuted;
      });
    }
    sendSignal({ type: 'mute', userId: currentUser.id, muted: isMuted });
    return isMuted;
  }

  function setMuted(muted: boolean): void {
    if (isMuted === muted) return;
    isMuted = muted;
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => {
        t.enabled = !isMuted;
      });
    }
    sendSignal({ type: 'mute', userId: currentUser.id, muted: isMuted });
  }

  function toggleSpeaker(): boolean {
    isSpeakerOn = !isSpeakerOn;
    if (localStream) {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(localStream);
      const gain = audioCtx.createGain();
      gain.gain.value = isSpeakerOn ? 1.0 : 0.5;
      source.connect(gain);
      gain.connect(audioCtx.destination);
    }
    return isSpeakerOn;
  }

  function getLocalStream(): MediaStream | null {
    return localStream;
  }

  function destroy(): void {
    destroyed = true;
    endCall();
  }

  return {
    startCall,
    joinCall,
    endCall,
    toggleMute,
    setMuted,
    toggleSpeaker,
    getLocalStream,
    isMuted: () => isMuted,
    destroy,
  };
}
