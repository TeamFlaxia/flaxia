'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMimeType } from '@/lib/file-extensions';
import { formatCount } from '@/lib/format';
import { t } from '@/lib/i18n';
import { registerModal } from '@/lib/modal-state';
import { showToast } from '@/lib/toast';
import type { Post } from '@/types/post';

const AUTOSAVE_KEY = 'flaxia_draft_autosave';
const SAVED_DRAFTS_KEY = 'flaxia_saved_drafts';
const SAVE_COOLDOWN = 1000;
const MAX_CHARS = 200;

interface PostComposerProps {
  onPostCreated?: (post: Post) => void;
  currentUser?: { username: string; display_name?: string; avatar_key?: string } | null;
  onDraftSaved?: () => void;
  onClose?: () => void;
}

interface Draft {
  id: string;
  text: string;
  savedAt: number;
}

interface MentionSuggestion {
  type: 'user' | 'tag';
  value: string;
  label: string;
  sublabel: string;
  avatar?: string;
}

async function detectZipType(file: File): Promise<'html5' | 'dos' | null> {
  try {
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    let eocdOffset = buffer.byteLength - 22;
    while (eocdOffset >= 0) {
      if (view.getUint32(eocdOffset, true) === 0x06054b50) break;
      eocdOffset--;
    }
    if (eocdOffset < 0) return null;
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const numEntries = view.getUint16(eocdOffset + 10, true);
    let hasIndexHtml = false;
    let hasExe = false;
    let offset = cdOffset;
    for (let i = 0; i < numEntries; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      let name = '';
      for (let j = 0; j < nameLen; j++) name += String.fromCharCode(view.getUint8(offset + 46 + j));
      const lower = name.toLowerCase();
      if (lower === 'index.html' || lower === 'index.htm') hasIndexHtml = true;
      if (lower.endsWith('.exe') || lower.endsWith('.bat') || lower.endsWith('.com')) hasExe = true;
      offset += 46 + nameLen + extraLen + commentLen;
    }
    if (hasIndexHtml) return 'html5';
    if (hasExe) return 'dos';
    return null;
  } catch {
    return null;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return t('file_size.bytes', { size: bytes });
  if (bytes < 1024 * 1024) return t('file_size.kb', { size: (bytes / 1024).toFixed(1) });
  return t('file_size.mb', { size: (bytes / (1024 * 1024)).toFixed(1) });
}

function loadSavedDrafts(): Draft[] {
  try {
    const raw = localStorage.getItem(SAVED_DRAFTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDraftsToStorage(drafts: Draft[]) {
  try {
    localStorage.setItem(SAVED_DRAFTS_KEY, JSON.stringify(drafts));
  } catch {}
}

export default function PostComposer({ onPostCreated, currentUser, onDraftSaved, onClose }: PostComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const draftsDropdownRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const [text, setText] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedThumbnail, setSelectedThumbnail] = useState<File | null>(null);
  const [thumbnailPreviewUrl, setThumbnailPreviewUrl] = useState<string | null>(null);
  const [zipType, setZipType] = useState<'html5' | 'dos' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pollActive, setPollActive] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [pollDuration, setPollDuration] = useState('86400000');

  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  const [mentionType, setMentionType] = useState<'user' | 'tag'>('user');
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);

  const [savedDrafts, setSavedDrafts] = useState<Draft[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);
  const [saveCooldown, setSaveCooldown] = useState(false);

  const suggestTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const draftTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragCounter = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft.text) {
          setText(draft.text);
          if (draft.poll) {
            setPollActive(true);
            setPollQuestion(draft.poll.question || '');
            setPollOptions(draft.poll.options?.length ? [...draft.poll.options] : ['', '']);
            if (draft.poll.duration) setPollDuration(draft.poll.duration);
          }
        }
      }
    } catch {}
  }, []);

  const charCountColor = text.length > 180 ? (text.length >= MAX_CHARS ? 'var(--danger)' : 'var(--accent)') : 'var(--text-muted)';
  const canSubmit = text.trim().length > 0 && !isSubmitting;

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    if (val.length > MAX_CHARS) return;
    setText(val);
  }, []);

  const handleTextKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) {
      e.preventDefault();
    }
    if (e.key === 'Escape' && showMentionDropdown) {
      e.preventDefault();
      setShowMentionDropdown(false);
    }
    if (showMentionDropdown && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestionIndex(i => Math.min(i + 1, suggestions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestionIndex(i => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (suggestionIndex >= 0 && suggestionIndex < suggestions.length) {
          applySuggestion(suggestions[suggestionIndex].value);
        }
      }
    }
  }, [canSubmit, showMentionDropdown, suggestions, suggestionIndex]);

  const handleTextInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget;
    const val = textarea.value;
    const cursorPos = textarea.selectionStart;
    const before = val.slice(0, cursorPos);

    if (suggestTimeoutRef.current) clearTimeout(suggestTimeoutRef.current);
    abortRef.current?.abort();

    const atMatch = before.match(/@([^\s]*)$/);
    const tagMatch = before.match(/#([^\s]*)$/);

    if (atMatch) {
      setMentionType('user');
      setMentionStartPos(cursorPos - atMatch[0].length);
      const q = atMatch[1] || '';
      suggestTimeoutRef.current = setTimeout(() => fetchSuggestions('user', q), 200);
    } else if (tagMatch) {
      setMentionType('tag');
      setMentionStartPos(cursorPos - tagMatch[0].length);
      suggestTimeoutRef.current = setTimeout(() => fetchSuggestions('tag', tagMatch[1] || ''), 200);
    } else {
      setShowMentionDropdown(false);
      setSuggestions([]);
    }
  }, []);

  const fetchSuggestions = useCallback(async (type: 'user' | 'tag', q: string) => {
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      if (type === 'user') {
        const url = q ? `/api/search?type=users&q=${encodeURIComponent(q)}&limit=5` : '/api/search?type=users&q=a&limit=5';
        const res = await fetch(url, { credentials: 'include', signal: ac.signal });
        if (!res.ok) return;
        const data = await res.json() as { results: Array<{ username: string; display_name: string; avatar_key: string | null }> };
        const items = (data.results || []).map(u => ({
          type: 'user' as const, value: u.username, label: u.display_name || u.username, sublabel: `@${u.username}`, avatar: u.avatar_key || undefined,
        }));
        setSuggestions(items);
        setSuggestionIndex(items.length > 0 ? 0 : -1);
        setShowMentionDropdown(items.length > 0);
      } else {
        const res = await fetch(`/api/tags/suggest?q=${encodeURIComponent(q)}&limit=5`, { signal: ac.signal });
        if (!res.ok) return;
        const data = await res.json() as { tags: Array<{ tag: string; count: number }> };
        const items = (data.tags || []).map(t => ({
          type: 'tag' as const, value: t.tag, label: `#${t.tag}`, sublabel: `${t.count} posts`,
        }));
        setSuggestions(items);
        setSuggestionIndex(items.length > 0 ? 0 : -1);
        setShowMentionDropdown(items.length > 0);
      }
    } catch {}
  }, []);

  const applySuggestion = useCallback((value: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const val = textarea.value;
    const before = val.slice(0, mentionStartPos);
    const after = val.slice(textarea.selectionStart);
    let inserted = mentionType === 'tag' ? `#${value} ` : `@${value} `;
    if (mentionType === 'tag' && val[mentionStartPos] === '#') {
      inserted = `#${value} `;
    }
    const newText = before + inserted + after;
    setText(newText);
    setShowMentionDropdown(false);
    setSuggestions([]);
    requestAnimationFrame(() => {
      const pos = mentionStartPos + inserted.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    });
  }, [mentionStartPos, mentionType]);

  const handleSuggestionClick = useCallback((suggestion: MentionSuggestion) => {
    applySuggestion(suggestion.value);
  }, [applySuggestion]);

  const validateFile = useCallback((file: File): { valid: boolean; error?: string } => {
    const maxSize = 100 * 1024 * 1024;
    if (file.size > maxSize) return { valid: false, error: t('composer.file_too_large') };
    const allowedTypes = ['.js', '.wasm', '.html', '.gif', '.png', '.jpg', '.jpeg', '.mp3', '.wav', '.ogg', '.m4a', '.webm', '.zip', '.swf', '.jsdos'];
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!allowedTypes.includes(ext)) return { valid: false, error: t('composer.file_type_not_allowed') };
    return { valid: true };
  }, []);

  const handleFileSelect = useCallback(async (file: File) => {
    const validation = validateFile(file);
    if (!validation.valid) {
      showToast(validation.error || '', true);
      return;
    }
    setSelectedFile(file);
    if (file.name.endsWith('.zip')) {
      const type = await detectZipType(file);
      setZipType(type);
    } else {
      setZipType(null);
    }
  }, [validateFile]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  const clearFileSelection = useCallback(() => {
    setSelectedFile(null);
    setZipType(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleThumbnailSelect = useCallback((file: File) => {
    setSelectedThumbnail(file);
    const url = URL.createObjectURL(file);
    setThumbnailPreviewUrl(url);
  }, []);

  const clearThumbnail = useCallback(() => {
    setSelectedThumbnail(null);
    if (thumbnailPreviewUrl) URL.revokeObjectURL(thumbnailPreviewUrl);
    setThumbnailPreviewUrl(null);
    if (thumbnailInputRef.current) thumbnailInputRef.current.value = '';
  }, [thumbnailPreviewUrl]);

  const handleThumbnailInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleThumbnailSelect(file);
  }, [handleThumbnailSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  }, [handleFileSelect]);

  const togglePoll = useCallback(() => {
    setPollActive(p => !p);
    if (!pollActive) {
      setPollQuestion('');
      setPollOptions(['', '']);
    }
  }, [pollActive]);

  const addPollOption = useCallback(() => {
    setPollOptions(prev => [...prev, '']);
  }, []);

  const removePollOption = useCallback((index: number) => {
    setPollOptions(prev => prev.filter((_, i) => i !== index));
  }, []);

  const updatePollOption = useCallback((index: number, value: string) => {
    setPollOptions(prev => prev.map((o, i) => i === index ? value : o));
  }, []);

  const getPollData = useCallback(() => {
    if (!pollActive) return null;
    const question = pollQuestion.trim();
    const options = pollOptions.map(o => o.trim()).filter(o => o.length > 0);
    if (!question || options.length < 2) return null;
    const durationMs = parseInt(pollDuration, 10);
    const endsAt = new Date(Date.now() + durationMs).toISOString();
    return { question, options, multipleChoice: false, endsAt };
  }, [pollActive, pollQuestion, pollOptions, pollDuration]);

  // Draft autosave
  useEffect(() => {
    if (draftTimeoutRef.current) clearTimeout(draftTimeoutRef.current);
    draftTimeoutRef.current = setTimeout(() => {
      try {
        const draft: Record<string, unknown> = { text, savedAt: Date.now() };
        if (pollActive) {
          draft.poll = { question: pollQuestion, options: [...pollOptions], duration: pollDuration };
        }
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(draft));
        onDraftSaved?.();
      } catch {}
    }, 500);
    return () => {
      if (draftTimeoutRef.current) clearTimeout(draftTimeoutRef.current);
    };
  }, [text, pollActive, pollQuestion, pollOptions, pollDuration, onDraftSaved]);

  const saveExplicitDraft = useCallback(() => {
    if (!text.trim()) {
      showToast(t('composer.draft_empty'), true);
      return;
    }
    if (saveCooldown) return;
    setSaveCooldown(true);
    setTimeout(() => setSaveCooldown(false), SAVE_COOLDOWN);

    const drafts = loadSavedDrafts();

    if (loadedDraftId) {
      const existing = drafts.find(d => d.id === loadedDraftId);
      if (existing) {
        existing.text = text;
        existing.savedAt = Date.now();
        saveDraftsToStorage(drafts);
        onDraftSaved?.();
        showToast(t('composer.draft_updated'));
        setLoadedDraftId(null);
        setSavedDrafts(drafts);
        return;
      }
    }

    const duplicate = drafts.find(d => d.text === text);
    if (duplicate) {
      duplicate.savedAt = Date.now();
      saveDraftsToStorage(drafts);
      onDraftSaved?.();
      showToast(t('composer.draft_saved'));
      setSavedDrafts(drafts);
      return;
    }

    const draft: Draft = { id: Date.now().toString(36), text, savedAt: Date.now() };
    drafts.unshift(draft);
    if (drafts.length > 20) drafts.length = 20;
    saveDraftsToStorage(drafts);
    onDraftSaved?.();
    showToast(t('composer.draft_saved'));
    setLoadedDraftId(null);
    setSavedDrafts(drafts);
  }, [text, saveCooldown, loadedDraftId, onDraftSaved]);

  const deleteDraft = useCallback((id: string) => {
    const drafts = loadSavedDrafts().filter(d => d.id !== id);
    saveDraftsToStorage(drafts);
    if (loadedDraftId === id) setLoadedDraftId(null);
    setSavedDrafts(drafts);
    showToast(t('composer.draft_deleted'));
  }, [loadedDraftId]);

  const deleteAllDrafts = useCallback(() => {
    saveDraftsToStorage([]);
    setSavedDrafts([]);
    setLoadedDraftId(null);
    onDraftSaved?.();
  }, [onDraftSaved]);

  const loadDraft = useCallback((draft: Draft) => {
    setText(draft.text);
    setLoadedDraftId(draft.id);
    setShowDrafts(false);
  }, []);

  const clearAutoDraft = useCallback(() => {
    localStorage.removeItem(AUTOSAVE_KEY);
  }, []);

  // Submit
  const handleSubmit = useCallback(async () => {
    if (isSubmitting || !text.trim()) return;
    setIsSubmitting(true);
    setError(null);

    try {
      let postId: string | undefined;
      let gifKey: string | undefined;
      let zipKey: string | undefined;
      let swfKey: string | undefined;

      // Step 1: Prepare post if file is selected
      if (selectedFile) {
        const prepareResult = await preparePost(selectedFile, zipType);
        if (!prepareResult) throw new Error('Failed to prepare post');
        postId = prepareResult.postId;
        if (prepareResult.zipUploadUrl && prepareResult.zipKey) {
          zipKey = prepareResult.zipKey;
          const ok = await uploadFileDirect(selectedFile, prepareResult.zipUploadUrl);
          if (!ok) throw new Error('Failed to upload ZIP file');
        } else if (prepareResult.swfUploadUrl && prepareResult.swfKey) {
          swfKey = prepareResult.swfKey;
          const ok = await uploadFileDirect(selectedFile, prepareResult.swfUploadUrl);
          if (!ok) throw new Error('Failed to upload SWF file');
        } else if (prepareResult.gifUploadUrl && prepareResult.gifKey) {
          gifKey = prepareResult.gifKey;
          const ok = await uploadFileDirect(selectedFile, prepareResult.gifUploadUrl);
          if (!ok) throw new Error('Failed to upload file');
        }
      }

      // Step 2: Commit post
      let commitResult: { post: Post } | null;
      const poll = getPollData();

      if (selectedThumbnail) {
        const formData = new FormData();
        formData.append('text', text.trim());
        if (postId) formData.append('postId', postId);
        if (gifKey) formData.append('gifKey', gifKey);
        if (zipKey) formData.append('payloadKey', zipKey);
        if (swfKey) formData.append('swfKey', swfKey);
        formData.append('thumbnail', selectedThumbnail);
        if (poll) formData.append('poll', JSON.stringify(poll));

        const response = await fetch('/api/posts/commit', {
          method: 'POST', credentials: 'include', body: formData,
        });
        if (!response.ok) {
          let errMsg = 'Failed to create post';
          try {
            const errBody = await response.json() as { error?: string };
            if (errBody?.error) errMsg += `: ${errBody.error}`;
          } catch {
            const errText = await response.text().catch(() => '');
            if (errText) errMsg += `: ${errText.slice(0, 200)}`;
          }
          throw new Error(errMsg);
        }
        commitResult = await response.json();
      } else {
        commitResult = await commitPost(postId, gifKey, zipKey, swfKey, text.trim(), poll);
        if (!commitResult) throw new Error('Failed to commit post');
      }

      clearAutoDraft();
      setLoadedDraftId(null);
      setText('');
      clearFileSelection();
      if (pollActive) setPollActive(false);
      if (onPostCreated && commitResult?.post) onPostCreated(commitResult.post);
      onClose?.();
    } catch (err: unknown) {
      const e = err as { message?: string; details?: string };
      console.error('Failed to create post:', e);
      const msg = e?.message || t('composer.error_create_failed');
      showToast(`${msg}${e?.details ? ` (${e.details})` : ''}`, true);
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, text, selectedFile, zipType, selectedThumbnail, getPollData, pollActive, clearFileSelection, onPostCreated, onClose]);

  // Keyboard shortcut for submit
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit && !isSubmitting) {
        e.preventDefault();
        handleSubmit();
      }
    };
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, [canSubmit, isSubmitting, handleSubmit]);

  const openDrafts = useCallback(() => {
    setSavedDrafts(loadSavedDrafts());
    setShowDrafts(v => !v);
  }, []);

  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    return mins < 1 ? t('time.just_now') : days > 0 ? `${days}d` : hours > 0 ? `${hours}h` : `${mins}m`;
  };

  const avatarEl = useMemo(() => {
    if (!currentUser) return null;
    if (currentUser.avatar_key) {
      return <img src={`/api/images/${currentUser.avatar_key}`} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
    }
    return (
      <div style={{
        width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1.2rem', color: 'white', background: 'var(--accent)', flexShrink: 0,
      }}>
        {currentUser.username.charAt(0).toUpperCase()}
      </div>
    );
  }, [currentUser]);

  return (
    <div ref={composerRef} className="post-composer" style={{ position: 'relative' }}>
      {error && (
        <div style={{ padding: '0.5rem', background: '#fef2f2', color: '#ef4444', borderRadius: 4, marginBottom: '0.5rem', fontSize: '0.875rem' }}>
          {error}
        </div>
      )}

      <div className="composer-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div className="composer-header" style={{ display: 'flex', gap: '0.75rem', position: 'relative' }}>
          {avatarEl}
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            value={text}
            onChange={handleTextChange}
            onInput={handleTextInput}
            onKeyDown={handleTextKeyDown}
            placeholder={t('composer.placeholder')}
            maxLength={MAX_CHARS}
            style={{
              flex: 1, border: 'none', outline: 'none', resize: 'none',
              fontFamily: "'Noto Sans', monospace, sans-serif", fontSize: '1rem',
              lineHeight: 1.5, minHeight: 80, background: 'transparent', color: 'var(--text-primary)',
            }}
          />

          {showMentionDropdown && suggestions.length > 0 && (
            <div
              ref={mentionDropdownRef}
              className="mention-dropdown"
              style={{
                position: 'absolute', bottom: '100%', left: 52, zIndex: 100,
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                maxHeight: 200, overflowY: 'auto', minWidth: 200,
              }}
            >
              {suggestions.map((s, i) => (
                <div
                  key={`${s.type}-${s.value}`}
                  onClick={() => handleSuggestionClick(s)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.5rem 0.75rem', cursor: 'pointer',
                    background: i === suggestionIndex ? 'var(--bg-hover, rgba(0,0,0,0.04))' : 'transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={() => setSuggestionIndex(i)}
                >
                  {s.avatar && (
                    <img src={`/api/images/${s.avatar}`} alt="" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />
                  )}
                  <div>
                    <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>{s.label}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.sublabel}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {showDrafts && (
            <div
              ref={draftsDropdownRef}
              className="composer-drafts-dropdown"
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                maxHeight: 240, overflowY: 'auto',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                  {t('composer.list_drafts')}{savedDrafts.length > 0 ? ` (${savedDrafts.length})` : ''}
                </span>
                {savedDrafts.length > 0 && (
                  <button
                    onClick={deleteAllDrafts}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.75rem', fontFamily: 'inherit' }}
                  >
                    {t('composer.draft_delete_all')}
                  </button>
                )}
              </div>
              {savedDrafts.length === 0 ? (
                <div style={{ padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center' }}>
                  {t('composer.no_drafts')}
                </div>
              ) : (
                savedDrafts.map(d => (
                  <div
                    key={d.id}
                    onClick={() => loadDraft(d)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '0.5rem 0.75rem', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover, rgba(0,0,0,0.04))')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {d.text}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.5rem' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{timeAgo(d.savedAt)}</span>
                      <button
                        onClick={e => { e.stopPropagation(); deleteDraft(d.id); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.75rem' }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Drag drop zone */}
        <div
          className={`composer-file-dropzone ${isDragging ? 'dragging' : ''}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1rem', border: isDragging ? '2px dashed var(--accent)' : '2px dashed var(--border)',
            borderRadius: 8, background: isDragging ? 'var(--accent-alpha, rgba(34,197,94,0.05))' : 'transparent',
            transition: 'all 0.2s', minHeight: 60, cursor: 'pointer',
          }}
        >
          <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            {isDragging ? t('composer.drop_here') : `📎 ${t('composer.file_hint')}`}
          </span>
        </div>

        {/* File preview */}
        {selectedFile && (
          <div className="composer-file-preview" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0.5rem 0.75rem', background: 'var(--bg-secondary)', borderRadius: 8,
          }}>
            <span style={{ fontSize: '0.875rem' }}>{selectedFile.name} ({formatFileSize(selectedFile.size)}){zipType ? ` [${zipType}]` : ''}</span>
            <button onClick={clearFileSelection} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1rem' }}>✕</button>
          </div>
        )}

        {/* Thumbnail section */}
        {selectedFile && (
          <div className="composer-thumbnail-section">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('composer.thumbnail_label')}</span>
              <input
                ref={thumbnailInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.gif"
                onChange={handleThumbnailInputChange}
                style={{ display: 'none' }}
              />
              <button
                onClick={() => thumbnailInputRef.current?.click()}
                style={{
                  background: 'none', border: '1px solid var(--border)', borderRadius: 4,
                  padding: '0.25rem 0.5rem', cursor: 'pointer', fontSize: '0.75rem', fontFamily: 'inherit',
                }}
              >
                {t('composer.thumbnail_button')}
              </button>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('composer.thumbnail_hint')}</span>
            </div>
            {thumbnailPreviewUrl && (
              <div style={{ position: 'relative', marginTop: '0.5rem', display: 'inline-block' }}>
                <img src={thumbnailPreviewUrl} alt="thumbnail" style={{ maxWidth: 150, maxHeight: 100, borderRadius: 4 }} />
                <button onClick={clearThumbnail} style={{
                  position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%',
                  background: 'var(--danger)', color: 'white', border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem',
                }}>✕</button>
              </div>
            )}
          </div>
        )}

        <div className="composer-divider" style={{ borderTop: '1px solid var(--border)', margin: '0.25rem 0' }} />

        {/* Poll section */}
        {pollActive && (
          <div className="composer-poll-section">
            <div className="poll-form" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <input
                type="text"
                value={pollQuestion}
                onChange={e => setPollQuestion(e.target.value)}
                placeholder={t('poll.question_placeholder')}
                maxLength={100}
                style={{
                  padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 4,
                  fontFamily: 'inherit', fontSize: '0.875rem', background: 'transparent', color: 'var(--text-primary)',
                }}
              />
              {pollOptions.map((opt, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <input
                    type="text"
                    value={opt}
                    onChange={e => updatePollOption(i, e.target.value)}
                    placeholder={`${t('poll.option_placeholder')} ${i + 1}`}
                    maxLength={100}
                    style={{
                      flex: 1, padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 4,
                      fontFamily: 'inherit', fontSize: '0.875rem', background: 'transparent', color: 'var(--text-primary)',
                    }}
                  />
                  {pollOptions.length > 2 && (
                    <button
                      onClick={() => removePollOption(i)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: '0.8rem' }}
                    >
                      {t('poll.remove_option')}
                    </button>
                  )}
                </div>
              ))}
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <button
                  onClick={addPollOption}
                  style={{
                    background: 'none', border: '1px solid var(--border)', borderRadius: 4,
                    padding: '0.25rem 0.5rem', cursor: 'pointer', fontSize: '0.8rem', fontFamily: 'inherit',
                  }}
                >
                  {t('poll.add_option')}
                </button>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{t('poll.duration')}:</span>
                <select
                  value={pollDuration}
                  onChange={e => setPollDuration(e.target.value)}
                  style={{
                    padding: '0.25rem', border: '1px solid var(--border)', borderRadius: 4,
                    fontSize: '0.8rem', background: 'transparent', color: 'var(--text-primary)', fontFamily: 'inherit',
                  }}
                >
                  <option value="3600000">{t('poll.duration_1h')}</option>
                  <option value="21600000">{t('poll.duration_6h')}</option>
                  <option value="86400000">{t('poll.duration_1d')}</option>
                  <option value="259200000">{t('poll.duration_3d')}</option>
                  <option value="604800000">{t('poll.duration_7d')}</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="composer-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="composer-actions" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".js,.wasm,.html,.gif,.png,.jpg,.jpeg,.mp3,.wav,.ogg,.m4a,.webm,.zip,.swf,.jsdos"
              onChange={handleFileInputChange}
              style={{ display: 'none' }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem' }}
              title={t('composer.attach_file')}
            >
              📎
            </button>
            <button
              onClick={togglePoll}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem',
                color: pollActive ? 'var(--accent)' : undefined,
              }}
              title={t('poll.toggle_button')}
            >
              📊
            </button>
            <span className="composer-char-count" style={{ fontSize: '0.8rem', color: charCountColor }}>
              {t('composer.char_count', { current: text.length, max: MAX_CHARS })}
            </span>
            <button
              onClick={saveExplicitDraft}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem' }}
              title={t('composer.save_draft')}
            >
              💾
            </button>
            <button
              onClick={openDrafts}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem',
                color: showDrafts ? 'var(--accent)' : undefined,
              }}
              title={t('composer.list_drafts')}
            >
              📝
            </button>
          </div>
          <button
            className="composer-submit"
            onClick={handleSubmit}
            disabled={!canSubmit || isSubmitting}
            style={{
              padding: '0.5rem 1.5rem', borderRadius: 9999, border: 'none',
              background: canSubmit && !isSubmitting ? 'var(--accent)' : 'var(--border)',
              color: canSubmit && !isSubmitting ? 'white' : 'var(--text-muted)',
              cursor: canSubmit && !isSubmitting ? 'pointer' : 'not-allowed',
              fontWeight: 600, fontSize: '0.875rem', fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            {isSubmitting ? t('composer.posting') : t('composer.post_button')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Helper functions (not hooks)
async function preparePost(file: File, zipType: 'html5' | 'dos' | null):
  Promise<{ postId: string; gifUploadUrl?: string; gifKey?: string; zipUploadUrl?: string; zipKey?: string; swfUploadUrl?: string; swfKey?: string } | null> {
  try {
    const response = await fetch('/api/posts/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || getMimeType(file.name),
        payloadType: zipType === 'dos' ? 'dos' : undefined,
      }),
    });
    if (!response.ok) {
      let errMsg = 'Failed to prepare post';
      try {
        const errBody = await response.json() as Record<string, unknown>;
        if (errBody?.error) errMsg += `: ${errBody.error}`;
      } catch {}
      throw new Error(errMsg);
    }
    const result = await response.json() as {
      postId: string; zipUploadUrl?: string; zipKey?: string;
      swfUploadUrl?: string; swfKey?: string; gifUploadUrl?: string; gifKey?: string;
    };
    if (result.zipUploadUrl && result.zipKey) {
      return { postId: result.postId, zipUploadUrl: result.zipUploadUrl, zipKey: result.zipKey };
    } else if (result.swfUploadUrl && result.swfKey) {
      return { postId: result.postId, swfUploadUrl: result.swfUploadUrl, swfKey: result.swfKey };
    } else {
      return { postId: result.postId, gifUploadUrl: result.gifUploadUrl, gifKey: result.gifKey };
    }
  } catch (error) {
    console.error('Prepare post failed:', error);
    throw error;
  }
}

async function uploadFileDirect(file: File, uploadUrl: string): Promise<boolean> {
  try {
    const response = await fetch(uploadUrl, {
      method: 'PUT', body: file,
      headers: { 'Content-Type': file.type },
      credentials: 'include',
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('Upload failed:', text);
      return false;
    }
    return true;
  } catch (error) {
    console.error('File upload failed:', error);
    return false;
  }
}

async function commitPost(
  postId: string | undefined, gifKey: string | undefined, zipKey: string | undefined,
  swfKey: string | undefined, text: string,
  poll?: { question: string; options: string[]; multipleChoice: boolean; endsAt?: string } | null,
): Promise<{ post: Post } | null> {
  try {
    const hashtagRegex = /#([a-zA-Z0-9_\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+)/gu;
    const hashtagSet = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = hashtagRegex.exec(text)) !== null) hashtagSet.add(match[1]);
    const hashtags = Array.from(hashtagSet);

    const response = await fetch('/api/posts/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        postId: postId || crypto.randomUUID(),
        gifKey, zipKey, swfKey, text, hashtags,
        poll: poll || undefined,
      }),
    });
    if (!response.ok) {
      let errMsg = 'Failed to commit post';
      try {
        const errBody = await response.json() as Record<string, unknown>;
        if (errBody?.error) errMsg += `: ${errBody.error}`;
      } catch {
        const errText = await response.text().catch(() => '');
        if (errText) errMsg += `: ${errText.slice(0, 200)}`;
      }
      throw new Error(errMsg);
    }
    return await response.json() as { post: Post };
  } catch (error) {
    console.error('Commit post failed:', error);
    return null;
  }
}
