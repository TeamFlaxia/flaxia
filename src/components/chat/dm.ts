import { getStoredSrpSalt, verifyCurrentPassword } from '../../lib/auth-srp.js';
import { t } from '../../lib/i18n.js';
import { getSignedMediaUrl } from '../../lib/media-token.js';
import { unwrapStringWithKek, wrapStringWithKek } from '../../lib/messenger-dm-cache.js';
import { decryptDmMessageV2, encryptDmMessageV2, resetDmRatchet } from '../../lib/messenger-dm-session.js';
import {
  ensureE2EEIdentityV2,
  isIdentityV2Unlocked,
  unlockIdentityV2FromSession,
  unlockIdentityV2WithPassword,
} from '../../lib/messenger-identity-v2.js';
import {
  checkRatchetResetRequest,
  clearRatchetResetRequest,
  requestRatchetReset,
} from '../../lib/messenger-prekeys.js';
import {
  decryptDmText,
  decryptFileForDm,
  encryptDmText,
  encryptFileForDm,
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

// Ratchet recovery (re-bootstrapping X3DH) is MANUAL only — triggered from the
// "再確立" button on a failed message. Auto-resetting on a decrypt failure wiped
// our own ratchet state and could destroy decryptable history in an endless
// loop. A brand-new conversation still auto-bootstraps on the first outgoing
// message (see encryptDmMessageV2), which is safe because nobody has sent yet.

export class DmTransport implements MessageTransport {
  readonly scope = 'dm' as const;
  private peerUserId: string | null = null;
  private keyVersion = 1;
  private unlockPromise: Promise<boolean> | null = null;
  // Message ids whose KEK-wrapped plaintext we've already pushed to the server,
  // so a reload on another device can read history without the ratchet.
  private plaintextUploaded = new Set<string>();

  constructor(private readonly conversationId: string) {}

  async setPeer(userId: string, keyVersion: number): Promise<void> {
    this.peerUserId = userId;
    this.keyVersion = keyVersion || 1;
  }

  private async unlock(): Promise<boolean> {
    try {
      return await unlockIdentityFromSession();
    } catch {
      return false;
    }
  }

  private async unlockV2(): Promise<boolean> {
    try {
      if (isIdentityV2Unlocked()) return true;
      if (await unlockIdentityV2FromSession()) return true;
      const pw = globalThis.prompt?.('Enter your account password to enable end-to-end encrypted messages');
      if (!pw) return false;
      const valid = await verifyCurrentPassword(pw);
      if (!valid) {
        showToast('パスワードが正しくありません', true);
        return false;
      }
      // Use the server-stored encSalt first — it is the authoritative salt
      // that was actually used to encrypt the identity keys.
      if (await unlockIdentityV2WithPassword(pw)) return true;
      // Fallback: derive KEK from the SRP salt. If the identity can't be
      // decrypted, ensureE2EEIdentityV2 will overwrite it with a fresh one
      // using the same SRP salt — keeping the KEK consistent for future
      // password changes.
      const salt = getStoredSrpSalt();
      if (salt && (await ensureE2EEIdentityV2(pw, salt))) return true;
      showToast('Could not enable E2EE identity', true);
      return false;
    } catch (e) {
      console.error('[e2ee] unlockV2 exception:', e);
      return false;
    }
  }

  async fetchMessages(
    cursor: string | null,
    limit: number,
  ): Promise<{ messages: ChatMessage[]; nextCursor: string | null }> {
    const cp = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const res = await fetch(`/api/dm/conversations/${this.conversationId}/messages?limit=${limit}${cp}`, {
      credentials: 'include',
    });
    if (!res.ok) return { messages: [], nextCursor: null };
    const data = (await res.json()) as { messages: ApiMessage[]; next_cursor: string | null };
    void this.maybeHandlePeerReset();
    return {
      messages: (data.messages || []).map((m) => mapMessage(m, 'dm', this.conversationId)),
      nextCursor: data.next_cursor,
    };
  }

  async pollMessages(cursor: string): Promise<ChatMessage[]> {
    const res = await fetch(
      `/api/dm/conversations/${this.conversationId}/messages?limit=10&cursor=${encodeURIComponent(cursor)}`,
      { credentials: 'include' },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { messages: ApiMessage[] };
    void this.maybeHandlePeerReset();
    return (data.messages || []).map((m) => mapMessage(m, 'dm', this.conversationId));
  }

  // If the peer has asked us to re-bootstrap X3DH (because they could not
  // decrypt our messages), reset our local session so the next outgoing
  // message establishes a fresh ratchet. This makes "Reset secure session"
  // recover both sides automatically.
  private async maybeHandlePeerReset(): Promise<void> {
    if (!this.peerUserId) return;
    try {
      const requested = await checkRatchetResetRequest(this.conversationId);
      if (requested) {
        resetDmRatchet(this.conversationId, this.peerUserId);
        await clearRatchetResetRequest(this.conversationId);
      }
    } catch {
      /* ignore */
    }
  }

  async markRead(): Promise<void> {
    await fetch(`/api/dm/conversations/${this.conversationId}/read`, { method: 'POST', credentials: 'include' });
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    const res = await fetch(`/api/dm/conversations/${this.conversationId}/messages/${messageId}`, {
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
      const prepareRes = await fetch(`/api/dm/conversations/${this.conversationId}/messages/prepare`, {
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
      if (this.peerUserId && (await this.unlock())) {
        const ab = await opts.file.arrayBuffer();
        const enc = await encryptFileForDm(
          this.conversationId,
          this.keyVersion,
          this.peerUserId,
          prepareData.storageKey,
          ab,
        );
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
    if (content && this.peerUserId) {
      if (await this.unlockV2()) {
        try {
          const env = await encryptDmMessageV2(this.conversationId, this.peerUserId, content);
          body.content = JSON.stringify({ ct: env.ciphertext, x3dh: env.x3dh ?? undefined });
          body.encVersion = 2;
          body.ratchetPub = env.header.ratchetPub;
          body.ratchetPn = env.header.pn;
          body.ratchetN = env.header.n;
          // Persist our own KEK-wrapped plaintext so we can read it on another
          // device (where no ratchet session exists). Server never sees raw text.
          try {
            const wrapped = await wrapStringWithKek(content);
            body.plaintextEnc = wrapped.enc;
            body.plaintextIv = wrapped.iv;
          } catch {
            /* best-effort; the ratchet still decrypts locally */
          }
          encryptedMessage = true;
        } catch {
          /* fall back to v1 */
        }
      }
      if (!encryptedMessage) {
        const encrypted = await encryptDmText(this.conversationId, this.keyVersion, this.peerUserId, content);
        if (encrypted) {
          body.content = encrypted.ciphertext;
          body.contentIv = encrypted.iv;
          body.encVersion = 1;
          body.keyVersion = this.keyVersion;
          encryptedMessage = true;
        }
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

    const res = await fetch(`/api/dm/conversations/${this.conversationId}/messages`, {
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
    return mapMessage((await res.json()) as ApiMessage, 'dm', this.conversationId);
  }

  async editMessage(messageId: string, content: string): Promise<Partial<ChatMessage> | null> {
    let body: Record<string, unknown> = { content };
    if (content && this.peerUserId) {
      if (await this.unlockV2()) {
        try {
          const env = await encryptDmMessageV2(this.conversationId, this.peerUserId, content);
          let plaintextEnc: string | undefined;
          let plaintextIv: string | undefined;
          try {
            const wrapped = await wrapStringWithKek(content);
            plaintextEnc = wrapped.enc;
            plaintextIv = wrapped.iv;
          } catch {
            /* best-effort */
          }
          body = {
            content: JSON.stringify({ ct: env.ciphertext, x3dh: env.x3dh ?? undefined }),
            encVersion: 2,
            ratchetPub: env.header.ratchetPub,
            ratchetPn: env.header.pn,
            ratchetN: env.header.n,
            plaintextEnc,
            plaintextIv,
          };
        } catch {
          /* fall back to v1 */
        }
      }
      if (!body.encVersion) {
        const encrypted = await encryptDmText(this.conversationId, this.keyVersion, this.peerUserId, content);
        if (encrypted) {
          body = {
            content: encrypted.ciphertext,
            contentIv: encrypted.iv,
            encVersion: 1,
            keyVersion: this.keyVersion,
          };
        }
      }
    }
    const res = await fetch(`/api/dm/conversations/${this.conversationId}/messages/${messageId}`, {
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
      ratchet_pub?: string | null;
      ratchet_pn?: number | null;
      ratchet_n?: number | null;
      edited_at: string;
    };
    return {
      content: updated.content ?? content,
      content_iv: updated.content_iv ?? null,
      enc_version: updated.enc_version ?? null,
      key_version: updated.key_version ?? null,
      ratchet_pub: updated.ratchet_pub ?? null,
      ratchet_pn: updated.ratchet_pn ?? null,
      ratchet_n: updated.ratchet_n ?? null,
      edited_at: updated.edited_at,
    };
  }

  async startEditDecrypt(msg: ChatMessage): Promise<string> {
    if (!this.peerUserId) return msg.content;
    try {
      if (msg.enc_version === 2 && msg.ratchet_pub) {
        const plain = await decryptDmMessageV2(this.conversationId, this.peerUserId, msg.content, {
          ratchetPub: msg.ratchet_pub,
          pn: msg.ratchet_pn || 0,
          n: msg.ratchet_n || 0,
        });
        if (plain) return plain;
      } else if (msg.enc_version === 1) {
        const plain = await decryptDmText(
          this.conversationId,
          msg.key_version || this.keyVersion,
          this.peerUserId,
          msg.content,
          msg.content_iv || '',
        );
        if (plain) return plain;
      }
      // Cross-device fallback: our own KEK-wrapped plaintext backup.
      if (msg.plaintext_enc && msg.plaintext_iv) {
        return await unwrapStringWithKek(msg.plaintext_enc, msg.plaintext_iv);
      }
    } catch {
      /* fall through to raw content */
    }
    return msg.content;
  }

  async decryptTextInto(el: HTMLElement, msg: ChatMessage): Promise<void> {
    if (!this.peerUserId) return;
    if (msg.enc_version === 2) {
      if (!isIdentityV2Unlocked()) {
        if (!this.unlockPromise) {
          this.unlockPromise = this.unlockV2().finally(() => {
            this.unlockPromise = null;
          });
        }
        const ok = await this.unlockPromise;
        if (!ok) {
          this.renderDmLocked(el, msg);
          return;
        }
      }
      if (msg.ratchet_pub) {
        try {
          const plain = await decryptDmMessageV2(this.conversationId, this.peerUserId, msg.content, {
            ratchetPub: msg.ratchet_pub,
            pn: msg.ratchet_pn || 0,
            n: msg.ratchet_n || 0,
          });
          if (plain && el.isConnected) {
            el.classList.remove('msg-row-encrypted');
            el.textContent = plain;
            await this.enrichText(el, plain);
            // Persist our KEK-wrapped plaintext so we can read it on another
            // device (where no ratchet session exists). Idempotent per message.
            void this.uploadPlaintext(msg, plain);
            return;
          }
          if (el.isConnected) this.renderDmDecryptFailed(el);
          return;
        } catch (e) {
          const errMsg = (e as Error | undefined)?.message ?? '';
          if (errMsg === 'OPK_UNRECOVERABLE') {
            if (el.isConnected) this.renderDmDecryptPrefixed(el);
            return;
          }
          // No session anywhere (e.g. after a manual reset): this message
          // cannot be decrypted until either side sends a fresh X3DH bootstrap.
          // Recovery is manual only — never wipe our own ratchet here.
          if (errMsg.startsWith('No ratchet session')) {
            if (el.isConnected) this.renderDmDecryptPending(el);
            return;
          }
          // Cross-device fallback: our own KEK-wrapped plaintext backup survives
          // a missing/advanced ratchet (new device, cleared local cache). The
          // server stores only the wrapped blob and cannot read it.
          if (msg.plaintext_enc && msg.plaintext_iv) {
            try {
              const plain = await unwrapStringWithKek(msg.plaintext_enc, msg.plaintext_iv);
              if (plain && el.isConnected) {
                el.classList.remove('msg-row-encrypted');
                el.textContent = plain;
                await this.enrichText(el, plain);
                return;
              }
            } catch {
              /* fall through to failed UI */
            }
          }
          // A failed decrypt must NOT auto-reset the ratchet: that destroys
          // decryptable history and can loop forever. The user re-establishes
          // the session via the "再確立" button.
          if (el.isConnected) this.renderDmDecryptFailed(el);
          return;
        }
      }
    }
    try {
      const plain = await decryptDmText(
        this.conversationId,
        msg.key_version || this.keyVersion,
        this.peerUserId,
        msg.content,
        msg.content_iv || '',
      );
      if (!plain) {
        if (el.isConnected) this.renderDmDecryptFailed(el);
        return;
      }
      if (!el.isConnected) return;
      el.classList.remove('msg-row-encrypted');
      el.textContent = plain;
      await this.enrichText(el, plain);
    } catch (e) {
      console.error('DM v1 decrypt failed:', e);
      if (el.isConnected) this.renderDmDecryptFailed(el);
    }
  }

  private renderDmLocked(el: HTMLElement, msg: ChatMessage): void {
    el.classList.add('msg-row-encrypted');
    el.textContent = '';
    const btn = document.createElement('button');
    btn.className = 'msg-decrypt-unlock';
    btn.textContent = '🔒 ロック解除して表示';
    btn.addEventListener('click', async () => {
      if (await this.unlockV2()) await this.decryptTextInto(el, msg);
    });
    el.appendChild(btn);
  }

  // Push our own KEK-wrapped plaintext to the server so we can read this message
  // on another device where no ratchet session exists. Best-effort and debounced
  // per message id; the row is upserted server-side.
  private async uploadPlaintext(msg: ChatMessage, plaintext: string): Promise<void> {
    if (!msg.id || this.plaintextUploaded.has(msg.id)) return;
    this.plaintextUploaded.add(msg.id);
    try {
      const wrapped = await wrapStringWithKek(plaintext);
      await fetch(`/api/dm/conversations/${this.conversationId}/messages/${msg.id}/plaintext`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ plaintextEnc: wrapped.enc, plaintextIv: wrapped.iv }),
      });
    } catch {
      /* best-effort: local ratchet + IndexedDB cache still cover this device */
      this.plaintextUploaded.delete(msg.id);
    }
  }

  private renderDmDecryptFailed(el: HTMLElement): void {
    el.classList.add('msg-row-encrypted');
    el.textContent = '⚠️ 復号できませんでした';
    const btn = document.createElement('button');
    btn.className = 'msg-decrypt-unlock';
    btn.textContent = '🔄 暗号セッションを再確立';
    btn.addEventListener('click', () => {
      resetDmRatchet(this.conversationId, this.peerUserId ?? '');
      void requestRatchetReset(this.conversationId);
      showToast('セッションをリセットしました。新しいメッセージを送信すると再確立されます。');
      el.textContent = '🔄 セッションをリセットしました — 新しいメッセージを送信してください';
    });
    el.appendChild(btn);
  }

  private renderDmDecryptPrefixed(el: HTMLElement): void {
    el.classList.add('msg-row-encrypted');
    el.textContent = '⚠️ このメッセージは暗号化アップデート前に送信されたため復号できません';
  }

  // No ratchet session exists (yet/anymore). Once either side sends a new
  // message the X3DH session is re-established; this message may then still
  // be undecryptable, but the conversation itself recovers automatically.
  private renderDmDecryptPending(el: HTMLElement): void {
    el.classList.add('msg-row-encrypted');
    el.textContent = '⏳ 暗号セッション未確立 — 新しいメッセージを送信すると再確立されます';
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
    const isEnc = !!msg.enc_version && this.peerUserId !== null;

    if (isEnc && key) {
      void this.decryptAttachment(msg, key).then((res) => {
        if (!res || !container.isConnected) return;
        container.innerHTML = '';
        if (key.startsWith('dm/audio/')) {
          const player = createAudioPlayer({ gifKey: key, postId: msg.id, src: res.url });
          player.style.maxWidth = '300px';
          container.appendChild(player);
        } else if (key.startsWith('dm/video/')) {
          const player = createVideoPlayer({ gifKey: key, postId: msg.id, src: res.url });
          player.style.maxWidth = '100%';
          container.appendChild(player);
        } else if (key.startsWith('dm/gif/')) {
          const preview = createImagePreview({ gifKey: key, postId: msg.id, src: res.url });
          preview.style.maxWidth = '100%';
          container.appendChild(preview);
        } else if (key.startsWith('dm/zip/') || key.startsWith('dm/html/')) {
          this.renderZipAttachment(container, msg, res.url);
        } else if (key.startsWith('dm/swf/')) {
          this.renderSwfAttachment(container, msg, res.data);
        }
      });
      return;
    }

    if (gifKey && gifKey.startsWith('dm/audio/')) {
      const player = createAudioPlayer({ gifKey, postId: msg.id });
      player.style.maxWidth = '300px';
      container.appendChild(player);
    } else if (gifKey && gifKey.startsWith('dm/video/')) {
      const player = createVideoPlayer({ gifKey, postId: msg.id });
      player.style.maxWidth = '100%';
      container.appendChild(player);
    } else if (gifKey && gifKey.startsWith('dm/gif/')) {
      const preview = createImagePreview({ gifKey, postId: msg.id });
      preview.style.maxWidth = '100%';
      container.appendChild(preview);
    } else if (payloadKey && (payloadKey.startsWith('dm/zip/') || payloadKey.startsWith('dm/html/'))) {
      this.renderZipAttachment(container, msg);
    } else if (swfKey && swfKey.startsWith('dm/swf/')) {
      this.renderSwfAttachment(container, msg);
    }
  }

  private async decryptAttachment(msg: ChatMessage, key: string): Promise<{ url: string; data: ArrayBuffer } | null> {
    if (!this.peerUserId) return null;
    try {
      let signedUrl = '';
      if (key.startsWith('dm/audio/')) {
        signedUrl = await getSignedMediaUrl('audio', key);
      } else {
        signedUrl = await getSignedMediaUrl('image', key);
      }
      const res = await fetch(signedUrl, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      const plain = await decryptFileForDm(
        this.conversationId,
        msg.key_version || this.keyVersion,
        this.peerUserId,
        key,
        data,
      );
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
    btn.innerHTML = '<span style="font-size:24px">📦</span> ' + t('messages.open_zip');
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
    btn.innerHTML = '<span style="font-size:24px">⚡</span> ' + t('messages.play_flash');
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
    title.textContent = 'Open ZIP';
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
    title.textContent = 'Play Flash';
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
