import { type CallClient, type CallClientCallbacks, createCallClient } from '../lib/call-client';
import { registerModal } from '../lib/modal-state';
import { showToast } from '../lib/toast';
import type { CallParticipant } from '../types/call';

interface CallUIConfig {
  roomId: string;
  wsUrl: string;
  callType: 'audio' | 'video';
  currentUser: { id: string; username?: string; display_name?: string | null; avatar_key?: string | null };
  targetUser?: { username?: string; display_name?: string | null; avatar_key?: string | null };
  isIncoming: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onEnded: () => void;
}

interface CallUIHandle {
  element: HTMLElement;
  destroy: () => void;
}

export function createCallUI(config: CallUIConfig): CallUIHandle {
  let client: CallClient | null = null;
  let destroyed = false;
  let callDuration = 0;
  let durationInterval: ReturnType<typeof setInterval> | null = null;

  const unregisterModal = registerModal();

  const overlay = document.createElement('div');
  overlay.className = 'call-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'call-dialog';

  const statusBar = document.createElement('div');
  statusBar.className = 'call-status-bar';

  const participantSection = document.createElement('div');
  participantSection.className = 'call-participants';

  const controls = document.createElement('div');
  controls.className = 'call-controls';

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function renderIncoming(): void {
    dialog.innerHTML = '';
    statusBar.textContent = '';

    const avatarImg = config.targetUser?.avatar_key
      ? `https://cdn.flaxia.app/avatars/${config.targetUser.avatar_key}`
      : null;

    dialog.innerHTML = `
      <div class="call-incoming">
        <div class="call-avatar">
          ${avatarImg ? `<img src="${avatarImg}" alt="" />` : `<div class="call-avatar-placeholder">${(config.targetUser?.display_name || config.targetUser?.username || '?')[0]}</div>`}
        </div>
        <div class="call-caller-name">${config.targetUser?.display_name || config.targetUser?.username || 'Unknown'}</div>
        <div class="call-type-label">${config.callType === 'video' ? 'Video call' : 'Voice call'}</div>
        <div class="call-incoming-actions">
          <button class="call-btn call-btn-decline" data-action="decline">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <button class="call-btn call-btn-accept" data-action="accept">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          </button>
        </div>
      </div>
    `;
  }

  function renderActive(): void {
    dialog.innerHTML = '';
    statusBar.textContent = '';

    // Participants display
    participantSection.innerHTML = '<div class="call-participants-list"></div>';

    // Duration display
    statusBar.textContent = formatDuration(callDuration);

    controls.innerHTML = `
      <button class="call-btn call-btn-mute" data-action="mute" title="Mute">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        <span>Mute</span>
      </button>
      <button class="call-btn call-btn-speaker" data-action="speaker" title="Speaker">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        <span>Speaker</span>
      </button>
      <button class="call-btn call-btn-end" data-action="end" title="End call">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        <span>End</span>
      </button>
    `;
  }

  function updateParticipantsList(participants: CallParticipant[]): void {
    const list = participantSection.querySelector('.call-participants-list');
    if (!list) return;
    list.innerHTML = participants
      .filter((p) => p.user_id !== config.currentUser.id)
      .map(
        (p) => `
        <div class="call-participant-item">
          <div class="call-participant-avatar">
            ${p.avatar_key ? `<img src="https://cdn.flaxia.app/avatars/${p.avatar_key}" alt="" />` : `<div class="call-participant-avatar-placeholder">${(p.display_name || p.username || '?')[0]}</div>`}
          </div>
          <div class="call-participant-info">
            <div class="call-participant-name">${p.display_name || p.username}</div>
            <div class="call-participant-status">${p.muted ? 'Muted' : 'Connected'}</div>
          </div>
          ${p.muted ? '<div class="call-participant-muted"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></div>' : ''}
        </div>
      `,
      )
      .join('');
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
      const items = participantSection.querySelector('.call-participants-list');
      if (items) {
        const existingParticipants = Array.from(items.children).length;
        updateParticipantsList(
          Array.from({ length: existingParticipants + 1 }, (_, i) =>
            i === existingParticipants ? participant : ({ user_id: '' } as CallParticipant),
          ),
        );
      }
    },
    onParticipantLeft: (_userId: string) => {},
    onMuteChanged: (userId: string, muted: boolean) => {
      const items = participantSection.querySelectorAll('.call-participant-item');
      for (const item of items) {
        const nameEl = item.querySelector('.call-participant-name');
        if (nameEl && nameEl.textContent) {
          // Approximate matching
          const statusEl = item.querySelector('.call-participant-status');
          if (statusEl) {
            statusEl.textContent = muted ? 'Muted' : 'Connected';
          }
          const muteIcon = item.querySelector('.call-participant-muted');
          if (muted && !muteIcon) {
            item.insertAdjacentHTML(
              'beforeend',
              '<div class="call-participant-muted"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></div>',
            );
          } else if (!muted && muteIcon) {
            muteIcon.remove();
          }
        }
      }
    },
    onParticipantsList: (participants: CallParticipant[]) => {
      updateParticipantsList(participants);
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
      case 'accept':
        startActiveCall();
        break;
      case 'decline':
        declineCall();
        break;
      case 'mute':
        if (client) {
          const muted = client.toggleMute();
          actionBtn.classList.toggle('call-btn-active', muted);
        }
        break;
      case 'speaker':
        if (client) {
          const on = client.toggleSpeaker();
          actionBtn.classList.toggle('call-btn-active', on);
        }
        break;
      case 'end':
        endActiveCall();
        break;
    }
  }

  async function startActiveCall(): Promise<void> {
    if (!config.wsUrl) {
      showToast('Cannot connect to call', true);
      return;
    }

    client = createCallClient(config.roomId, config.wsUrl, config.currentUser, callbacks);

    if (config.isIncoming) {
      await client.joinCall();
    } else {
      await client.startCall();
    }

    config.onAccept?.();

    // Start duration timer
    callDuration = 0;
    durationInterval = setInterval(() => {
      callDuration++;
      statusBar.textContent = formatDuration(callDuration);
    }, 1000);

    renderActive();
    overlay.appendChild(dialog);
    overlay.appendChild(statusBar);
    overlay.appendChild(controls);
    overlay.appendChild(participantSection);
  }

  function declineCall(): void {
    config.onDecline?.();
    cleanup();
    config.onEnded();
  }

  function endActiveCall(): void {
    if (client) {
      client.endCall();
    }
    // Also notify server
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

  overlay.addEventListener('click', handleButtonClick);

  if (config.isIncoming) {
    renderIncoming();
    overlay.appendChild(dialog);
  } else {
    // Outgoing call - immediately start
    startActiveCall();
  }

  return {
    element: overlay,
    destroy: cleanup,
  };
}

// Incoming call notification - used when a call push notification arrives
export function showIncomingCallNotification(
  callId: string,
  callerName: string,
  callerAvatar: string | null,
  callType: 'audio' | 'video',
  currentUser: { id: string; username?: string; display_name?: string | null; avatar_key?: string | null },
  onAnswer: () => void,
  onDecline: () => void,
): void {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/api/ws/call?roomId=${callId}&token=`;

  const ui = createCallUI({
    roomId: callId,
    wsUrl,
    callType,
    currentUser,
    targetUser: { display_name: callerName, avatar_key: callerAvatar },
    isIncoming: true,
    onAccept: onAnswer,
    onDecline,
    onEnded: () => {
      onDecline();
    },
  });

  document.body.appendChild(ui.element);
}
