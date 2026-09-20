import { t } from '../../lib/i18n.js';
import {
  decryptFileForServer,
  decryptServerText,
  encryptFileForServer,
  encryptServerText,
} from '../../lib/messenger-store.js';
import { registerModal } from '../../lib/modal-state.js';
import { showToast } from '../../lib/toast.js';
import { executeZipAuto } from '../../lib/zip-manager.js';
import { createAudioPlayer } from '../AudioPlayer.js';
import { executeFlash } from '../FlashPlayer.js';
import { createVideoPlayer } from '../VideoPlayer.js';
import { type ApiMessage, mapMessage } from './mappers.js';
import type { ChatMessage, MessageTransport } from './types.js';

function detectBlobMime(key: string): string {
  const name = key.toLowerCase();
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.ogg')) return 'audio/ogg';
  if (name.endsWith('.m4a')) return 'audio/mp4';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mp4')) return 'video/mp4';
  if (name.endsWith('.mov')) return 'video/quicktime';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'text/html';
  return 'application/octet-stream';
}

export class ServerChannelTransport implements MessageTransport {
  readonly scope = 'server-channel' as const;
  private channelId: string | null = null;
  private keyVersion = 1;
  private onMarkRead?: () => void;

  constructor(private readonly serverId: string) {}

  setChannel(channelId: string, keyVersion: number): void {
    this.channelId = channelId;
    this.keyVersion = keyVersion || 1;
  }

  setOnMarkRead(cb: () => void): void {
    this.onMarkRead = cb;
  }

  async fetchMessages(
    cursor: string | null,
    limit: number,
  ): Promise<{ messages: ChatMessage[]; nextCursor: string | null }> {
    if (!this.channelId) return { messages: [], nextCursor: null };
    const cp = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const res = await fetch(`/api/servers/${this.serverId}/channels/${this.channelId}/messages?limit=${limit}${cp}`, {
      credentials: 'include',
    });
    if (!res.ok) return { messages: [], nextCursor: null };
    const data = (await res.json()) as { messages: ApiMessage[]; next_cursor: string | null };
    return {
      messages: (data.messages || []).map((m) => mapMessage(m, 'server-channel', this.channelId as string)),
      nextCursor: data.next_cursor,
    };
  }

  async pollMessages(cursor: string): Promise<ChatMessage[]> {
    if (!this.channelId) return [];
    const res = await fetch(
      `/api/servers/${this.serverId}/channels/${this.channelId}/messages?limit=10&after=${encodeURIComponent(cursor)}`,
      { credentials: 'include' },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { messages: ApiMessage[] };
    return (data.messages || []).map((m) => mapMessage(m, 'server-channel', this.channelId as string));
  }

  async markRead(): Promise<void> {
    if (!this.channelId) return;
    await fetch(`/api/servers/${this.serverId}/channels/${this.channelId}/read`, {
      method: 'POST',
      credentials: 'include',
    });
    this.onMarkRead?.();
    window.dispatchEvent(new CustomEvent('serverUnreadChanged'));
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    if (!this.channelId) return false;
    const res = await fetch(`/api/servers/${this.serverId}/channels/${this.channelId}/messages/${messageId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return res.ok;
  }

  async sendMessage(opts: { content: string; file: File | null; stampId?: string }): Promise<ChatMessage | null> {
    if (!this.channelId) return null;
    const content = opts.content;
    let gifKey: string | undefined;
    let payloadKey: string | undefined;
    let swfKey: string | undefined;
    let messageId: string | undefined;
    let contentIv: string | undefined;
    let encVersion: number | undefined;
    let keyVersion: number | undefined;
    let encryptedContent = '';

    if (content) {
      const enc = await encryptServerText(this.serverId, this.channelId, this.keyVersion, content);
      if (enc) {
        encryptedContent = enc.ciphertext;
        contentIv = enc.iv;
        encVersion = 1;
        keyVersion = this.keyVersion;
      }
    }

    if (opts.file) {
      const upload = await this.uploadAttachment(opts.file, keyVersion);
      if (!upload) return null;
      messageId = upload.messageId;
      gifKey = upload.gifKey;
      payloadKey = upload.payloadKey;
      swfKey = upload.swfKey;
      if (!contentIv && encVersion) {
        keyVersion = upload.keyVersion;
      }
    }

    const body: Record<string, unknown> = {};
    body.content = encryptedContent || content || '';
    if (gifKey) body.gifKey = gifKey;
    if (payloadKey) body.payloadKey = payloadKey;
    if (swfKey) body.swfKey = swfKey;
    if (messageId) body.messageId = messageId;
    if (contentIv) body.contentIv = contentIv;
    if (encVersion) body.encVersion = encVersion;
    if (keyVersion !== undefined) body.keyVersion = keyVersion;
    if (opts.stampId) body.stampId = opts.stampId;

    const res = await fetch(`/api/servers/${this.serverId}/channels/${this.channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      showToast(err.error || t('messages.send_failed'), true);
      return null;
    }
    return mapMessage((await res.json()) as ApiMessage, 'server-channel', this.channelId);
  }

  private async uploadAttachment(
    file: File,
    keyVersion: number | undefined,
  ): Promise<{ messageId: string; gifKey?: string; payloadKey?: string; swfKey?: string; keyVersion: number } | null> {
    if (!this.channelId) return null;
    try {
      const prepareRes = await fetch(`/api/servers/${this.serverId}/channels/${this.channelId}/messages/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ filename: file.name }),
      });
      if (!prepareRes.ok) {
        const err = (await prepareRes.json().catch(() => ({}))) as { error?: string };
        showToast(err.error || t('composer.error_upload_failed'), true);
        return null;
      }
      const prepareData = (await prepareRes.json()) as {
        msgId: string;
        uploadUrl: string;
        gifKey?: string;
        payloadKey?: string;
        swfKey?: string;
      };
      const raw = await file.arrayBuffer();
      const encrypted = await encryptFileForServer(
        this.serverId,
        this.channelId,
        keyVersion || this.keyVersion,
        prepareData.msgId,
        raw,
      );
      if (!encrypted) {
        showToast(t('servers.e2ee_unavailable'), true);
        return null;
      }
      const uploadRes = await fetch(prepareData.uploadUrl, {
        method: 'PUT',
        body: encrypted as unknown as BodyInit,
        credentials: 'include',
      });
      if (!uploadRes.ok) {
        showToast(t('composer.error_upload_failed'), true);
        return null;
      }
      return {
        messageId: prepareData.msgId,
        gifKey: prepareData.gifKey,
        payloadKey: prepareData.payloadKey,
        swfKey: prepareData.swfKey,
        keyVersion: keyVersion || this.keyVersion,
      };
    } catch {
      showToast(t('composer.error_upload_failed'), true);
      return null;
    }
  }

  async editMessage(messageId: string, content: string): Promise<Partial<ChatMessage> | null> {
    if (!this.channelId) return null;
    let bodyContent = content;
    let contentIv: string | undefined;
    let encVersion: number | undefined;
    let keyVersion: number | undefined;

    const enc = await encryptServerText(this.serverId, this.channelId, this.keyVersion, content);
    if (enc) {
      bodyContent = enc.ciphertext;
      contentIv = enc.iv;
      encVersion = 1;
      keyVersion = this.keyVersion;
    }

    const res = await fetch(`/api/servers/${this.serverId}/channels/${this.channelId}/messages/${messageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content: bodyContent, contentIv, encVersion, keyVersion }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      showToast(err.error || t('messages.edit_failed'), true);
      return null;
    }
    const updated = (await res.json()) as {
      id: string;
      content?: string;
      content_iv?: string | null;
      enc_version?: number | null;
      key_version?: number | null;
      edited_at?: string | null;
    };
    return {
      content: updated.content ?? bodyContent,
      content_iv: updated.content_iv ?? null,
      enc_version: updated.enc_version ?? null,
      key_version: updated.key_version ?? null,
      edited_at: updated.edited_at ?? null,
    };
  }

  async startEditDecrypt(msg: ChatMessage): Promise<string> {
    if (!this.channelId || !msg.enc_version || !msg.content_iv) return msg.content;
    const plain = await decryptServerText(
      this.serverId,
      this.channelId,
      msg.key_version || this.keyVersion,
      msg.content,
      msg.content_iv,
    );
    return plain || msg.content;
  }

  async decryptTextInto(el: HTMLElement, msg: ChatMessage): Promise<void> {
    if (!this.channelId) return;
    const plain = await decryptServerText(
      this.serverId,
      this.channelId,
      msg.key_version || this.keyVersion,
      msg.content,
      msg.content_iv || '',
    );
    if (!plain) return;
    if (!el.isConnected) return;
    el.classList.remove('msg-row-encrypted');
    el.textContent = plain;
    await this.enrichText(el, plain);
  }

  private async enrichText(el: HTMLElement, content: string): Promise<void> {
    const { linkifyHashtags, linkifyUrls, processText } = await import('../PostText.js');
    try {
      el.innerHTML = await processText(content);
      linkifyUrls(el);
      linkifyHashtags(el);
    } catch {
      /* ignore */
    }
  }

  renderAttachment(container: HTMLElement, msg: ChatMessage): void {
    if (!this.channelId) return;
    const gifKey = msg.gif_key;
    const payloadKey = msg.payload_key;
    const swfKey = msg.swf_key;
    const keyVersion = msg.key_version || this.keyVersion;

    const unlock = async (key: string): Promise<Blob | null> => {
      try {
        const res = await fetch(`/api/servers/files/${key}`, { credentials: 'include' });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const dec = await decryptFileForServer(this.serverId, this.channelId as string, keyVersion, msg.id, buf);
        if (!dec) return null;
        const mime = detectBlobMime(key);
        return new Blob([dec], { type: mime });
      } catch {
        return null;
      }
    };

    if (gifKey && /server\/audio\//.test(gifKey)) {
      void unlock(gifKey).then((blob) => {
        if (!blob || !container.isConnected) return;
        const url = URL.createObjectURL(blob);
        const player = createAudioPlayer({ gifKey: '', postId: msg.id, src: url } as never);
        player.style.maxWidth = '300px';
        container.appendChild(player);
      });
    } else if (gifKey && /server\/video\//.test(gifKey)) {
      void unlock(gifKey).then((blob) => {
        if (!blob || !container.isConnected) return;
        const url = URL.createObjectURL(blob);
        const player = createVideoPlayer({ gifKey: '', postId: msg.id, src: url });
        player.style.maxWidth = '100%';
        container.appendChild(player);
      });
    } else if (gifKey && /server\/gif\//.test(gifKey)) {
      void unlock(gifKey).then((blob) => {
        if (!blob || !container.isConnected) return;
        const url = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.className = 'image-preview-img';
        img.style.cssText = 'max-width:100%; border-radius:8px; cursor:pointer;';
        img.src = url;
        img.alt = t('image_preview.post_preview', { id: msg.id });
        img.addEventListener('click', () => window.open(url, '_blank'));
        container.appendChild(img);
      });
    } else if (payloadKey && /server\/(zip|html)\//.test(payloadKey)) {
      void unlock(payloadKey).then((blob) => {
        if (!container.isConnected) return;
        const btn = document.createElement('div');
        btn.className = 'execution-button server-attachment-btn';
        btn.textContent = '📦 ' + t('messages.open_zip');
        if (blob) btn.addEventListener('click', () => this.openZip(blob, msg));
        else {
          btn.style.opacity = '0.5';
          btn.textContent = t('messages.encrypted');
        }
        container.appendChild(btn);
      });
    } else if (swfKey && /server\/swf\//.test(swfKey)) {
      void unlock(swfKey).then((blob) => {
        if (!container.isConnected) return;
        const btn = document.createElement('div');
        btn.className = 'execution-button server-attachment-btn';
        if (blob) btn.textContent = '⚡ ' + t('messages.play_flash');
        else {
          btn.textContent = t('messages.encrypted');
          btn.style.opacity = '0.5';
        }
        btn.addEventListener('click', () => this.openSwf(blob, msg));
        container.appendChild(btn);
      });
    }
  }

  private openZip(blob: Blob | null, msg: ChatMessage): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.className = 'server-zip-overlay';
    const modal = document.createElement('div');
    modal.className = 'server-zip-modal';
    const header = document.createElement('div');
    header.className = 'server-zip-header';
    const title = document.createElement('span');
    title.textContent = t('messages.open_zip');
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });
    header.appendChild(title);
    header.appendChild(closeBtn);
    const content = document.createElement('div');
    content.className = 'server-zip-content';
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });
    if (!blob) {
      content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">${t('messages.encrypted')}</div>`;
      return;
    }
    const url = URL.createObjectURL(blob);
    void executeZipAuto(msg.id, content, url).catch(() => {
      content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">${t('post_stage.zip_load_error')}</div>`;
    });
  }

  private openSwf(blob: Blob | null, msg: ChatMessage): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.className = 'server-zip-overlay';
    const modal = document.createElement('div');
    modal.className = 'server-zip-modal';
    const header = document.createElement('div');
    header.className = 'server-zip-header';
    const title = document.createElement('span');
    title.textContent = t('messages.play_flash');
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      unregister();
      overlay.remove();
    });
    header.appendChild(title);
    header.appendChild(closeBtn);
    const content = document.createElement('div');
    content.className = 'server-zip-content';
    content.style.background = '#000';
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        unregister();
        overlay.remove();
      }
    });
    if (!blob) {
      content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">${t('messages.encrypted')}</div>`;
      return;
    }
    void blob
      .arrayBuffer()
      .then((data) => executeFlash(msg.id, content, '', false, data))
      .catch(() => {
        content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">${t('post_stage.flash_load_error')}</div>`;
      });
  }
}
