import type { CallParticipant, SignalMessage } from '../types/call';

const STUN_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }],
};

export interface CallClientCallbacks {
  onRemoteStream: (userId: string, stream: MediaStream) => void;
  onRemoteStreamRemoved: (userId: string) => void;
  onCallEnded: (userId: string) => void;
  onParticipantJoined: (participant: CallParticipant) => void;
  onParticipantLeft: (userId: string) => void;
  onMuteChanged: (userId: string, muted: boolean) => void;
  onParticipantsList: (participants: CallParticipant[]) => void;
  onError: (error: string) => void;
}

export interface CallClient {
  connect(): Promise<void>;
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
  const peerConnections = new Map<string, RTCPeerConnection>();
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

  function getOrCreatePC(userId: string): RTCPeerConnection {
    let pc = peerConnections.get(userId);
    if (pc) return pc;

    pc = new RTCPeerConnection(STUN_SERVERS);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: 'ice-candidate',
          userId: currentUser.id,
          candidate: event.candidate.toJSON(),
          targetUserId: userId,
        });
      }
    };

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        callbacks.onRemoteStream(userId, event.streams[0]);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'disconnected' || pc?.connectionState === 'failed') {
        closePeerConnection(userId);
        callbacks.onParticipantLeft(userId);
      }
    };

    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    peerConnections.set(userId, pc);
    return pc;
  }

  function closePeerConnection(userId: string): void {
    const pc = peerConnections.get(userId);
    if (pc) {
      pc.close();
      peerConnections.delete(userId);
      callbacks.onRemoteStreamRemoved(userId);
    }
  }

  async function handleSignalMessage(msg: SignalMessage): Promise<void> {
    switch (msg.type) {
      case 'participants':
        if (msg.participants) {
          callbacks.onParticipantsList(msg.participants as unknown as CallParticipant[]);
        }
        break;

      case 'join':
        if (msg.userId && msg.userId !== currentUser.id) {
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

          const pc = getOrCreatePC(msg.userId);
          if (pc.signalingState === 'stable') {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignal({
              type: 'offer',
              userId: currentUser.id,
              sdp: offer.sdp!,
              targetUserId: msg.userId,
            });
          }
        }
        break;

      case 'leave':
        if (msg.userId && msg.userId !== currentUser.id) {
          closePeerConnection(msg.userId);
          callbacks.onParticipantLeft(msg.userId);
        }
        break;

      case 'offer':
        if (msg.sdp && msg.userId && msg.userId !== currentUser.id) {
          const pc = getOrCreatePC(msg.userId);
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ type: 'answer', userId: currentUser.id, sdp: answer.sdp!, targetUserId: msg.userId });
        }
        break;

      case 'answer':
        if (msg.sdp && msg.userId) {
          const pc = peerConnections.get(msg.userId);
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
          }
        }
        break;

      case 'ice-candidate':
        if (msg.candidate && msg.userId) {
          const pc = peerConnections.get(msg.userId);
          if (pc) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch {
              // ignore invalid candidates
            }
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

  async function connect(): Promise<void> {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch {
      callbacks.onError('Microphone access denied');
      return;
    }

    await connectSignaling();
  }

  function endCall(): void {
    for (const [userId, pc] of peerConnections) {
      pc.close();
      callbacks.onRemoteStreamRemoved(userId);
    }
    peerConnections.clear();

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
    connect,
    endCall,
    toggleMute,
    setMuted,
    toggleSpeaker,
    getLocalStream,
    isMuted: () => isMuted,
    destroy,
  };
}
