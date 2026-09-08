import { t } from '../../lib/i18n.js';
import { getSignedMediaUrl } from '../../lib/media-token.js';
import {
  decryptFileForGroup,
  decryptGroupText,
  encryptFileForGroup,
  encryptGroupText,
  unlockIdentityFromSession,
} from '../../lib/messenger-store.js';
import { registerModal } from '../../lib/modal-state.js';
import { showToast } from '../../lib/toast.js';
import { executeZipAuto } from '../../lib/zip-manager.js';
import { createAudioPlayer } from '../AudioPlayer.js';
import { executeFlash } from '../FlashPlayer.js';
import { createImagePreview } from '../ImagePreview.js';
import { createVideoPlayer } from '../VideoPlayer.js';
import { type ApiMessage, mapMessage } from './mappers.js';
import type { ChatMessage, MessageTransport } from './types.js';

export class GroupTransport implements MessageTransport {
  readonly scope = 'group' as const;
  private keyVersion = 1;

  constructor(private readonly groupId: string) {}

  async setKeyVersion(keyVersion: number): Promise<void> {
    this.keyVersion = keyVersion || 1;
  }

  private async unlock(): Promise<boolean> {
    try {
      return await unlockIdentityFromSession();
    } catch {
      return false;
    }
  }

  async fetchMessages(
    cursor: string | null,
    limit: number,
  ): Promise<{ messages: ChatMessage[]; nextCursor: string | null }> {
    const cp = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const res = await fetch(`/api/groups/${this.groupId}/messages?limit=${limit}${cp}`, {
      credentials: 'include',
    });
    if (!res.ok) return { messages: [], nextCursor: null };
    const data = (await res.json()) as { messages: ApiMessage[]; next_cursor: string | null };
    return {
      messages: (data.messages || []).map((m) => mapMessage(m, 'group', this.groupId)),
      nextCursor: data.next_cursor,
    };
  }

  async pollMessages(cursor: string): Promise<ChatMessage[]> {
    const res = await fetch(`/api/groups/${this.groupId}/messages?limit=10&cursor=${encodeURIComponent(cursor)}`, {
      credentials: 'include',
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { messages: ApiMessage[] };
    return (data.messages || []).map((m) => mapMessage(m, 'group', this.groupId));
  }

  async markRead(): Promise<void> {
    await fetch(`/api/groups/${this.groupId}/read`, { method: 'POST', credentials: 'include' });
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    const res = await fetch(`/api/groups/${this.groupId}/messages/${messageId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return res.ok;
  }

  async sendMessage(opts: { content: string; file: File | null; stampId?: string }): Promise<ChatMessage | null> {
    const content = opts.content;
    let gifKey: string | undefined;
    let payloadKey: string | undefined;
    let swfKey: string | undefined;
    let messageId: string | undefined;
    let encryptedUpload = false;

    if (opts.file) {
      const prepareRes = await fetch(`/api/groups/${this.groupId}/messages/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ filename: opts.file.name }),
      });
      if (!prepareRes.ok) {
        const err = (await prepareRes.json().catch(() => ({}))) as { error?: string };
        showToast(err.error || 'Failed to prepare upload', true);
        return null;
      }
      const prepareData = (await prepareRes.json()) as {
        msgId: string;
        uploadUrl: string;
        storageKey: string;
        gifKey?: string;
        payloadKey?: string;
        swfKey?: string;
      };
      messageId = prepareData.msgId;
      gifKey = prepareData.gifKey;
      payloadKey = prepareData.payloadKey;
      swfKey = prepareData.swfKey;

      let uploadBody: Blob = opts.file;
      if (await this.unlock()) {
        const ab = await opts.file.arrayBuffer();
        const enc = await encryptFileForGroup(this.groupId, this.keyVersion, prepareData.storageKey, ab);
        if (enc) {
          uploadBody = new Blob([enc.buffer as ArrayBuffer], { type: 'application/octet-stream' });
          encryptedUpload = true;
        }
      }
      const uploadRes = await fetch(prepareData.uploadUrl, { method: 'PUT', body: uploadBody, credentials: 'include' });
      if (!uploadRes.ok) {
        showToast('Failed to upload file', true);
        return null;
      }
    }

    const body: Record<string, unknown> = {};
    let encryptedMessage = false;
    if (content) {
      const encrypted = await encryptGroupText(this.groupId, this.keyVersion, content);
      if (encrypted) {
        body.content = encrypted.ciphertext;
        body.contentIv = encrypted.iv;
        body.encVersion = 1;
        body.keyVersion = this.keyVersion;
        encryptedMessage = true;
      }
    }
    if (encryptedUpload) {
      body.encVersion = 1;
      body.keyVersion = this.keyVersion;
      encryptedMessage = true;
    }
    if (!encryptedMessage && content) body.content = content;
    if (gifKey) body.gifKey = gifKey;
    if (payloadKey) body.payloadKey = payloadKey;
    if (swfKey) body.swfKey = swfKey;
    if (messageId) body.messageId = messageId;
    if (opts.stampId) body.stampId = opts.stampId;

    const res = await fetch(`/api/groups/${this.groupId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      showToast(err.error || 'Send failed', true);
      return null;
    }
    return mapMessage((await res.json()) as ApiMessage, 'group', this.groupId);
  }

  async editMessage(messageId: string, content: string): Promise<Partial<ChatMessage> | null> {
    let body: Record<string, unknown> = { content };
    if (content) {
      const encrypted = await encryptGroupText(this.groupId, this.keyVersion, content);
      if (encrypted) {
        body = {
          content: encrypted.ciphertext,
          contentIv: encrypted.iv,
          encVersion: 1,
          keyVersion: this.keyVersion,
        };
      }
    }
    const res = await fetch(`/api/groups/${this.groupId}/messages/${messageId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      showToast(err.error || 'Edit failed', true);
      return null;
    }
    const updated = (await res.json()) as {
      id: string;
      content?: string;
      content_iv?: string | null;
      enc_version?: number | null;
      key_version?: number | null;
      edited_at: string;
    };
    return {
      content: updated.content ?? content,
      content_iv: updated.content_iv ?? null,
      enc_version: updated.enc_version ?? null,
      key_version: updated.key_version ?? null,
      edited_at: updated.edited_at,
    };
  }

  async startEditDecrypt(msg: ChatMessage): Promise<string> {
    return msg.content;
  }

  async decryptTextInto(el: HTMLElement, msg: ChatMessage): Promise<void> {
    const plain = await decryptGroupText(
      this.groupId,
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
    const gifKey = msg.gif_key;
    const payloadKey = msg.payload_key;
    const swfKey = msg.swf_key;
    const key = gifKey || payloadKey || swfKey;
    const isEnc = !!msg.enc_version;

    if (isEnc && key) {
      void this.decryptAttachment(msg, key).then((res) => {
        if (!res || !container.isConnected) return;
        container.innerHTML = '';
        if (key.startsWith('group/audio/')) {
          const player = createAudioPlayer({ gifKey: key, postId: msg.id, src: res.url });
          player.style.maxWidth = '300px';
          container.appendChild(player);
        } else if (key.startsWith('group/video/')) {
          const player = createVideoPlayer({ gifKey: key, postId: msg.id, src: res.url });
          player.style.maxWidth = '100%';
          container.appendChild(player);
        } else if (key.startsWith('group/gif/')) {
          const preview = createImagePreview({ gifKey: key, postId: msg.id, src: res.url });
          preview.style.maxWidth = '100%';
          container.appendChild(preview);
        } else if (key.startsWith('group/zip/') || key.startsWith('group/html/')) {
          this.renderZipAttachment(container, msg, res.url);
        } else if (key.startsWith('group/swf/')) {
          this.renderSwfAttachment(container, msg, res.data);
        }
      });
      return;
    }

    if (gifKey && gifKey.startsWith('group/audio/')) {
      const player = createAudioPlayer({ gifKey, postId: msg.id });
      player.style.maxWidth = '300px';
      container.appendChild(player);
    } else if (gifKey && gifKey.startsWith('group/video/')) {
      const player = createVideoPlayer({ gifKey, postId: msg.id });
      player.style.maxWidth = '100%';
      container.appendChild(player);
    } else if (gifKey && gifKey.startsWith('group/gif/')) {
      const preview = createImagePreview({ gifKey, postId: msg.id });
      preview.style.maxWidth = '100%';
      container.appendChild(preview);
    } else if (payloadKey && (payloadKey.startsWith('group/zip/') || payloadKey.startsWith('group/html/'))) {
      this.renderZipAttachment(container, msg);
    } else if (swfKey && swfKey.startsWith('group/swf/')) {
      this.renderSwfAttachment(container, msg);
    }
  }

  private async decryptAttachment(msg: ChatMessage, key: string): Promise<{ url: string; data: ArrayBuffer } | null> {
    try {
      let signedUrl = '';
      if (key.startsWith('group/audio/')) {
        signedUrl = await getSignedMediaUrl('audio', key);
      } else {
        signedUrl = await getSignedMediaUrl('image', key);
      }
      const res = await fetch(signedUrl, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      const plain = await decryptFileForGroup(this.groupId, msg.key_version || this.keyVersion, key, data);
      if (!plain) return null;
      const url = URL.createObjectURL(new Blob([plain]));
      return { url, data: plain };
    } catch {
      return null;
    }
  }

  private renderZipAttachment(container: HTMLElement, msg: ChatMessage, url?: string): void {
    const btn = document.createElement('div');
    btn.className = 'execution-button';
    btn.style.cssText = `
      display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 16px 24px; cursor: pointer;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; border-radius: 12px; font-weight: 600; font-size: 15px;
      max-width: 300px; transition: all 0.2s ease;
    `;
    btn.innerHTML = `<span style="font-size:24px">📦</span> ${t('messages.open_zip')}`;
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.02)';
      btn.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', () => this.executeZipModal(msg, url));
    container.appendChild(btn);
  }

  private renderSwfAttachment(container: HTMLElement, msg: ChatMessage, data?: ArrayBuffer): void {
    const btn = document.createElement('div');
    btn.className = 'execution-button';
    btn.style.cssText = `
      display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 16px 24px; cursor: pointer;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; border-radius: 12px; font-weight: 600; font-size: 15px;
      max-width: 300px; transition: all 0.2s ease;
    `;
    btn.innerHTML = `<span style="font-size:24px">⚡</span> ${t('messages.play_flash')}`;
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.02)';
      btn.style.boxShadow = '0 4px 20px rgba(102, 126, 234, 0.4)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', () => this.executeSwfModal(msg, data));
    container.appendChild(btn);
  }

  private executeZipModal(msg: ChatMessage, url?: string): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 9999;';
    const modal = document.createElement('div');
    modal.style.cssText =
      'width: 90%; max-width: 800px; height: 80vh; background: var(--bg-primary); border-radius: 12px; overflow: hidden; position: relative; display: flex; flex-direction: column;';
    const header = document.createElement('div');
    header.style.cssText =
      'display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; background: var(--bg-tertiary);';
    const title = document.createElement('span');
    title.style.cssText = 'font-weight: 600; font-size: 14px; color: var(--text-primary);';
    title.textContent = t('messages.open_zip');
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background: none; border: none; font-size: 18px; cursor: pointer; color: var(--text-muted); padding: 4px 8px;';
    closeBtn.addEventListener('click', () => destroy());
    header.appendChild(title);
    header.appendChild(closeBtn);
    const content = document.createElement('div');
    content.style.cssText = 'flex: 1; position: relative; background: var(--bg-primary);';
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const destroy = () => {
      unregister();
      overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) destroy();
    });
    void executeZipAuto(msg.id, content, url).catch(() => {
      content.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);">${t('post_stage.zip_load_error')}</div>`;
    });
  }

  private executeSwfModal(msg: ChatMessage, preloadedData?: ArrayBuffer): void {
    const unregister = registerModal();
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 9999;';
    const modal = document.createElement('div');
    modal.style.cssText =
      'width: 90%; max-width: 800px; height: 80vh; background: var(--bg-primary); border-radius: 12px; overflow: hidden; position: relative; display: flex; flex-direction: column;';
    const header = document.createElement('div');
    header.style.cssText =
      'display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; background: var(--bg-tertiary);';
    const title = document.createElement('span');
    title.style.cssText = 'font-weight: 600; font-size: 14px; color: var(--text-primary);';
    title.textContent = t('messages.play_flash');
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background: none; border: none; font-size: 18px; cursor: pointer; color: var(--text-muted); padding: 4px 8px;';
    closeBtn.addEventListener('click', () => destroy());
    header.appendChild(title);
    header.appendChild(closeBtn);
    const content = document.createElement('div');
    content.style.cssText =
      'flex: 1; position: relative; background: #000; display: flex; align-items: center; justify-content: center;';
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const destroy = () => {
      unregister();
      overlay.remove();
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) destroy();
    });
    void executeFlash(msg.id, content, undefined, false, preloadedData).catch(() => {
      content.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);">${t('post_stage.flash_load_error')}</div>`;
    });
  }
}
