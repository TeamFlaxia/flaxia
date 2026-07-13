import { type CallClient, type CallClientCallbacks, createCallClient } from '../lib/call-client';
import { registerModal } from '../lib/modal-state';
import { showToast } from '../lib/toast';
import type { CallParticipant } from '../types/call';

let activeCallHandle: CallUIHandle | null = null;

interface CallUIConfig {
  roomId: string;
  wsUrl: string;
  currentUser: { id: string; username?: string; display_name?: string | null; avatar_key?: string | null };
  onEnded: () => void;
}

interface CallUIHandle {
  element: HTMLElement;
  destroy: () => void;
}

export function createCallUI(config: CallUIConfig): CallUIHandle {
  // Destroy any existing active call UI
  if (activeCallHandle) {
    activeCallHandle.destroy();
    activeCallHandle = null;
  }

  let client: CallClient | null = null;
  let destroyed = false;
  let callDuration = 0;
  let durationInterval: ReturnType<typeof setInterval> | null = null;
  let participants: CallParticipant[] = [];

  const unregisterModal = registerModal();

  const overlay = document.createElement('div');
  overlay.className = 'call-bar';

  const barInner = document.createElement('div');
  barInner.className = 'call-bar-inner';

  // Duration / status
  const statusEl = document.createElement('div');
  statusEl.className = 'call-bar-status';

  // Participant avatars row
  const avatarsEl = document.createElement('div');
  avatarsEl.className = 'call-bar-avatars';

  // Controls
  const controlsEl = document.createElement('div');
  controlsEl.className = 'call-bar-controls';

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function renderControls(): void {
    controlsEl.innerHTML = `
      <button class="call-bar-btn" data-action="mute" title="Mute">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
      </button>
      <button class="call-bar-btn" data-action="speaker" title="Speaker">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
      </button>
      <button class="call-bar-btn call-bar-btn-end" data-action="end" title="End call">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
      </button>
    `;
  }

  function renderAvatars(): void {
    const allParticipants = [
      {
        user_id: config.currentUser.id,
        username: config.currentUser.username || '',
        display_name: config.currentUser.display_name || null,
        avatar_key: config.currentUser.avatar_key || null,
        muted: false,
      },
      ...participants.filter((p) => p.user_id !== config.currentUser.id),
    ];

    const maxVisible = 5;
    const visible = allParticipants.slice(0, maxVisible);
    const overflow = allParticipants.length - maxVisible;

    avatarsEl.innerHTML = visible
      .map(
        (p) => `
        <div class="call-bar-avatar${p.muted ? ' call-bar-avatar-muted' : ''}" title="${p.display_name || p.username}">
          ${p.avatar_key ? `<img src="https://cdn.flaxia.app/avatars/${p.avatar_key}" alt="" />` : `<div class="call-bar-avatar-placeholder">${(p.display_name || p.username || '?')[0]}</div>`}
          ${p.muted ? '<div class="call-bar-muted-badge"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></div>' : ''}
        </div>
      `,
      )
      .join('');

    if (overflow > 0) {
      const more = document.createElement('div');
      more.className = 'call-bar-avatar call-bar-avatar-more';
      more.textContent = `+${overflow}`;
      avatarsEl.appendChild(more);
    }
  }

  let remoteAudioEl: HTMLAudioElement | null = null;

  const callbacks: CallClientCallbacks = {
    onRemoteStream: (stream: MediaStream) => {
      if (remoteAudioEl) {
        remoteAudioEl.pause();
        remoteAudioEl.srcObject = null;
        remoteAudioEl.remove();
      }
      const audio = document.createElement('audio');
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.play().catch(() => {});
      remoteAudioEl = audio;
    },
    onRemoteStreamRemoved: () => {
      if (remoteAudioEl) {
        remoteAudioEl.pause();
        remoteAudioEl.srcObject = null;
        remoteAudioEl.remove();
        remoteAudioEl = null;
      }
    },
    onCallEnded: (_userId: string) => {
      if (!destroyed) {
        showToast('Call ended');
        cleanup();
        config.onEnded();
      }
    },
    onParticipantJoined: (participant: CallParticipant) => {
      participants = [...participants.filter((p) => p.user_id !== participant.user_id), participant];
      renderAvatars();
    },
    onParticipantLeft: (userId: string) => {
      participants = participants.filter((p) => p.user_id !== userId);
      renderAvatars();
    },
    onMuteChanged: (userId: string, muted: boolean) => {
      participants = participants.map((p) => (p.user_id === userId ? { ...p, muted } : p));
      renderAvatars();
    },
    onParticipantsList: (incoming: CallParticipant[]) => {
      participants = incoming;
      renderAvatars();
    },
    onError: (error: string) => {
      showToast(error, true);
    },
  };

  function handleButtonClick(e: Event): void {
    const target = e.target as HTMLElement;
    const actionBtn = target.closest('[data-action]') as HTMLElement;
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;

    switch (action) {
      case 'mute':
        if (client) {
          const muted = client.toggleMute();
          actionBtn.classList.toggle('call-bar-btn-active', muted);
        }
        break;
      case 'speaker':
        if (client) {
          const on = client.toggleSpeaker();
          actionBtn.classList.toggle('call-bar-btn-active', on);
          if (remoteAudioEl) {
            remoteAudioEl.volume = on ? 1.0 : 0.3;
          }
        }
        break;
      case 'end':
        endActiveCall();
        break;
    }
  }

  async function connect(): Promise<void> {
    if (!config.wsUrl) {
      showToast('Cannot connect to call', true);
      return;
    }

    client = createCallClient(config.roomId, config.wsUrl, config.currentUser, callbacks);
    await client.connect();

    callDuration = 0;
    durationInterval = setInterval(() => {
      callDuration++;
      statusEl.textContent = formatDuration(callDuration);
    }, 1000);
  }

  function endActiveCall(): void {
    if (client) {
      client.endCall();
    }
    fetch(`/api/calls/${config.roomId}/end`, { method: 'POST' }).catch(() => {});
    cleanup();
    config.onEnded();
  }

  function cleanup(): void {
    destroyed = true;
    if (client) {
      client.destroy();
      client = null;
    }
    if (remoteAudioEl) {
      remoteAudioEl.pause();
      remoteAudioEl.srcObject = null;
      remoteAudioEl.remove();
      remoteAudioEl = null;
    }
    if (durationInterval) {
      clearInterval(durationInterval);
      durationInterval = null;
    }
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    unregisterModal();
  }

  // Build layout
  statusEl.textContent = 'Connecting...';
  renderControls();
  renderAvatars();

  barInner.appendChild(statusEl);
  barInner.appendChild(avatarsEl);
  barInner.appendChild(controlsEl);
  overlay.appendChild(barInner);

  overlay.addEventListener('click', handleButtonClick);

  // Connect to signaling
  connect();

  const handle: CallUIHandle = {
    element: overlay,
    destroy: () => {
      cleanup();
      if (activeCallHandle === handle) {
        activeCallHandle = null;
      }
    },
  };
  activeCallHandle = handle;
  return handle;
}

export function showIncomingCallNotification(
  callId: string,
  _callerName: string,
  _callerAvatar: string | null,
  _callType: 'audio' | 'video',
  currentUser: { id: string; username?: string; display_name?: string | null; avatar_key?: string | null },
  onAnswer: () => void,
  onDecline: () => void,
): void {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/api/ws/call?roomId=${callId}&token=`;

  const ui = createCallUI({
    roomId: callId,
    wsUrl,
    currentUser,
    onEnded: () => {
      onDecline();
    },
  });

  document.body.appendChild(ui.element);
}
