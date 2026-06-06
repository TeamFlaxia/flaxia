'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { registerModal } from '@/lib/modal-state';
import type { Post } from '@/types/post';

interface ReplyComposerProps {
  postId: string;
  onReplyCreated: (reply: Post) => void;
  onCancel: () => void;
  prefillText?: string;
}

interface MentionSuggestion {
  type: 'user' | 'tag';
  value: string;
  label: string;
  sublabel?: string;
  avatar?: string;
}

export default function ReplyComposer({ postId, onReplyCreated, onCancel, prefillText }: ReplyComposerProps) {
  const { currentUser } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  const [text, setText] = useState(prefillText || '');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const suggestTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const mentionStartPos = useRef(-1);
  const mentionType = useRef<'user' | 'tag'>('user');

  const charCount = text.length;
  const canSubmit = text.trim().length > 0 && !isSubmitting;
  const maxChars = 200;

  const handleMention = useCallback((value: string) => {
    if (mentionStartPos.current < 0) return;
    const prefix = mentionType.current === 'tag' ? '#' : '@';
    const before = text.slice(0, mentionStartPos.current);
    const after = text.slice(textareaRef.current?.selectionStart || 0);
    const newText = `${before}${prefix}${value} ${after}`;
    setText(newText);
    setSuggestions([]);
    setTimeout(() => {
      if (textareaRef.current) {
        const pos = mentionStartPos.current + value.length + 2;
        textareaRef.current.setSelectionRange(pos, pos);
        textareaRef.current.focus();
      }
    }, 0);
  }, [text]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    if (val.length > maxChars) return;
    setText(val);

    const pos = e.target.selectionStart;
    const before = val.slice(0, pos);
    const atMatch = before.match(/@([a-zA-Z0-9_]*)$/);
    const tagMatch = before.match(/#([^\s]*)$/);

    clearTimeout(suggestTimeoutRef.current);
    abortRef.current?.abort();

    if (atMatch) {
      mentionType.current = 'user';
      mentionStartPos.current = pos - atMatch[0].length;
      const q = atMatch[1] || '';
      suggestTimeoutRef.current = setTimeout(async () => {
        const ac = new AbortController();
        abortRef.current = ac;
        try {
          const url = q ? `/api/search?type=users&q=${encodeURIComponent(q)}&limit=5` : '/api/search?type=users&q=a&limit=5';
          const res = await fetch(url, { credentials: 'include', signal: ac.signal });
          if (!res.ok) return;
          const data = (await res.json()) as { results: Array<{ username: string; display_name: string; avatar_key: string | null }> };
          setSuggestions((data.results || []).map(u => ({
            type: 'user' as const, value: u.username, label: u.display_name || u.username, sublabel: `@${u.username}`, avatar: u.avatar_key || undefined,
          })));
          setSuggestionIndex(0);
        } catch {}
      }, 200);
    } else if (tagMatch) {
      mentionType.current = 'tag';
      mentionStartPos.current = pos - tagMatch[0].length;
      suggestTimeoutRef.current = setTimeout(async () => {
        const ac = new AbortController();
        abortRef.current = ac;
        try {
          const res = await fetch(`/api/tags/suggest?q=${encodeURIComponent(tagMatch[1] || '')}&limit=5`, { signal: ac.signal });
          if (!res.ok) return;
          const data = (await res.json()) as { tags: Array<{ tag: string; count: number }> };
          setSuggestions((data.tags || []).map(t => ({
            type: 'tag' as const, value: t.tag, label: `#${t.tag}`, sublabel: `${t.count} posts`,
          })));
          setSuggestionIndex(0);
        } catch {}
      }, 200);
    } else {
      setSuggestions([]);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (suggestions.length > 0) {
        setSuggestions([]);
        return;
      }
      setSelectedFile(null);
      setText('');
      onCancel();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) {
      e.preventDefault();
      handleSubmit();
    }
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestionIndex(i => Math.min(i + 1, suggestions.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestionIndex(i => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); handleMention(suggestions[suggestionIndex].value); setSuggestions([]); }
    }
  }, [suggestions, canSubmit, onCancel, handleMention, suggestionIndex]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      alert(t('reply_composer.error_file_size'));
      return;
    }
    const allowed = ['image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm'];
    if (!allowed.includes(file.type)) {
      alert(t('reply_composer.error_file_type'));
      return;
    }
    setSelectedFile(file);
  }, [t]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') !== -1) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          if (file.size > 25 * 1024 * 1024) { alert(t('reply_composer.error_file_size')); return; }
          setSelectedFile(file);
        }
        break;
      }
    }
  }, [t]);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting || !text.trim()) return;
    setIsSubmitting(true);
    try {
      let gifKey: string | undefined;
      let replyId: string | undefined;

      if (selectedFile) {
        const prepRes = await fetch(`/api/posts/${postId}/replies/prepare`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ filename: selectedFile.name, contentType: selectedFile.type }),
        });
        if (!prepRes.ok) throw new Error(t('reply_composer.error_auth_required'));
        const prep = (await prepRes.json()) as { replyId: string; gifUploadUrl: string; gifKey: string };
        replyId = prep.replyId;
        gifKey = prep.gifKey;

        const uploadRes = await fetch(prep.gifUploadUrl, {
          method: 'PUT', body: selectedFile, headers: { 'Content-Type': selectedFile.type }, credentials: 'include',
        });
        if (!uploadRes.ok) throw new Error('Upload failed');
      }

      const hashtagRegex = /#([a-zA-Z0-9_\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\uff70-\uff9fー]+)/gu;
      const hashtags = Array.from(new Set(Array.from(text.matchAll(hashtagRegex), m => m[1])));

      const commitRes = await fetch(`/api/posts/${postId}/replies/commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ replyId: replyId || crypto.randomUUID(), gifKey, text: text.trim(), hashtags }),
      });
      if (!commitRes.ok) {
        if (commitRes.status === 401) throw new Error(t('reply_composer.error_auth_required'));
        throw new Error('Failed to commit');
      }
      const result = (await commitRes.json()) as { reply: Post };
      setText('');
      setSelectedFile(null);
      if (result.reply) onReplyCreated(result.reply);
    } catch (err) {
      console.error('Reply failed:', err);
      if ((err as Error).message === t('reply_composer.error_auth_required')) {
        const overlay = document.createElement('div');
        const unreg = registerModal();
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000;';
        overlay.innerHTML = `<div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:24px;max-width:320px;width:90%;text-align:center;"><p style="margin:0 0 16px;color:var(--text-primary);font-size:14px;">${t('sign_in_prompt.message')}</p><div style="display:flex;gap:8px;justify-content:center;"><button class="lgn" style="padding:8px 16px;background:var(--accent);border:none;border-radius:4px;color:#000;cursor:pointer;font-size:14px;">${t('common.login')}</button><button class="rgs" style="padding:8px 16px;background:none;border:1px solid var(--border);border-radius:4px;color:var(--text-primary);cursor:pointer;font-size:14px;">${t('common.register')}</button></div></div>`;
        overlay.querySelector('.lgn')?.addEventListener('click', () => { unreg(); overlay.remove(); router.push('/login'); });
        overlay.querySelector('.rgs')?.addEventListener('click', () => { unreg(); overlay.remove(); router.push('/register'); });
        document.body.appendChild(overlay);
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, text.trim(), selectedFile, postId, onReplyCreated, t, router]);

  useEffect(() => {
    return () => {
      clearTimeout(suggestTimeoutRef.current);
      abortRef.current?.abort();
    };
  }, []);

  return (
    <div className="reply-composer" style={{ border: '1px solid #e2e8f0', borderRadius: 0, padding: '1rem', marginTop: '0.75rem', background: '#ffffff' }}>
      <div className="reply-composer-body">
        <div className="reply-composer-header" style={{ position: 'relative', display: 'flex', gap: '0.75rem' }}>
          <div
            className="reply-composer-avatar"
            style={{
              width: 32, height: 32, borderRadius: '50%', background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.75rem', fontWeight: 'bold', flexShrink: 0,
              cursor: currentUser ? 'pointer' : 'default',
              backgroundSize: 'cover', backgroundPosition: 'center',
              ...(currentUser?.avatar_key ? { backgroundImage: `url(/api/images/${currentUser.avatar_key})`, color: 'transparent' } : {}),
            }}
            onClick={() => currentUser && router.push(`/users/${currentUser.username}`)}
          >
            {currentUser ? currentUser.username.charAt(0).toUpperCase() : '?'}
          </div>
          <textarea
            ref={textareaRef}
            className="reply-composer-textarea"
            placeholder={t('reply_composer.placeholder')}
            maxLength={maxChars}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            style={{
              flex: 1, border: 'none', outline: 'none', resize: 'none',
              fontFamily: "'Noto Sans', monospace, sans-serif", fontSize: '0.875rem',
              lineHeight: 1.5, minHeight: 40,
            }}
            autoFocus
          />
          {suggestions.length > 0 && (
            <div
              ref={dropdownRef}
              className="mention-dropdown"
              style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 40,
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                zIndex: 100, maxHeight: 200, overflowY: 'auto', minWidth: 200,
              }}
            >
              {suggestions.map((s, i) => (
                <div
                  key={`${s.type}-${s.value}`}
                  className={`mention-item ${i === suggestionIndex ? 'mention-item--active' : ''}`}
                  style={{
                    padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
                    background: i === suggestionIndex ? 'var(--bg-secondary, #f0f0f0)' : 'none',
                  }}
                  onClick={() => { handleMention(s.value); setSuggestions([]); }}
                  onMouseEnter={() => setSuggestionIndex(i)}
                >
                  {s.type === 'user' && (
                    <span style={{
                      width: 24, height: 24, borderRadius: '50%', background: 'var(--accent)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.7rem', fontWeight: 'bold', flexShrink: 0,
                      backgroundSize: 'cover', backgroundPosition: 'center',
                      ...(s.avatar ? { backgroundImage: `url(/api/images/${s.avatar})`, color: 'transparent' } : {}),
                    }}>{!s.avatar ? s.value.charAt(0).toUpperCase() : ''}</span>
                  )}
                  {s.type === 'tag' && <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 'bold', flexShrink: 0 }}>#</span>}
                  <div>
                    <div style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 500 }}>{s.label}</div>
                    {s.sublabel && <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{s.sublabel}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {selectedFile && (
          <div className="reply-composer-file-preview" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', padding: '0.5rem', background: 'var(--bg-secondary)', borderRadius: 4 }}>
            <span className="file-name" style={{ flex: 1, fontSize: '0.8125rem', color: 'var(--text-primary)' }}>
              {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
            </span>
            <button
              className="file-remove"
              onClick={() => setSelectedFile(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: '0.875rem', padding: '0.25rem' }}
            >
              ✕
            </button>
          </div>
        )}

        <div className="reply-composer-divider" style={{ borderTop: '1px solid #e2e8f0', margin: '0.75rem 0' }} />

        <div className="reply-composer-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="reply-composer-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gif,.png,.jpg,.jpeg,.mp3,.wav,.ogg,.m4a,.webm"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
            <button
              className="reply-composer-file-button"
              onClick={() => fileInputRef.current?.click()}
              style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '0.25rem', fontSize: '1rem' }}
            >
              📎
            </button>
            <span className="reply-composer-char-count" style={{
              color: charCount > 180 ? (charCount >= maxChars ? '#ef4444' : '#22c55e') : '#94a3b8',
              fontSize: '0.75rem',
            }}>
              {charCount}/{maxChars}
            </span>
          </div>
          <div className="reply-composer-buttons" style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              className="reply-composer-cancel"
              onClick={onCancel}
              style={{
                background: 'none', border: '1px solid #22c55e', color: '#22c55e',
                padding: '0.375rem 0.75rem', borderRadius: 0,
                fontFamily: "'Noto Sans', monospace, sans-serif",
                fontSize: '0.75rem', cursor: 'pointer',
              }}
            >
              {t('reply_composer.cancel')}
            </button>
            <button
              className="reply-composer-submit"
              disabled={!canSubmit}
              onClick={handleSubmit}
              style={{
                background: canSubmit ? '#22c55e' : '#e2e8f0',
                border: canSubmit ? '1px solid #22c55e' : '1px solid #e2e8f0',
                color: canSubmit ? '#000' : '#64748b',
                padding: '0.375rem 0.75rem', borderRadius: 0,
                fontFamily: "'Noto Sans', monospace, sans-serif",
                fontSize: '0.75rem', fontWeight: 'bold',
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
            >
              {isSubmitting ? t('reply_composer.replying') : t('reply_composer.reply')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
