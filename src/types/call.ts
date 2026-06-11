export type CallType = 'audio' | 'video';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed';

export interface Call {
  id: string;
  conversation_id: string | null;
  group_id: string | null;
  initiator_id: string;
  status: CallStatus;
  type: CallType;
  created_at: string;
  ended_at: string | null;
}

export interface CallParticipant {
  call_id: string;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  joined_at: string;
  left_at: string | null;
  muted: boolean;
}

export interface SignalMessage {
  type: 'join' | 'leave' | 'offer' | 'answer' | 'ice-candidate' | 'mute' | 'end-call' | 'participants';
  userId: string;
  username?: string;
  display_name?: string | null;
  avatar_key?: string | null;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  muted?: boolean;
  participants?: CallParticipant[];
  roomId?: string;
}
