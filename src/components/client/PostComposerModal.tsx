'use client';

import { useCallback, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Post } from '@/types/post';
import PostComposer from '@/components/client/PostComposer';
import { registerModal } from '@/lib/modal-state';

interface PostComposerModalProps {
  currentUser: { username: string; display_name?: string; avatar_key?: string } | null | undefined;
  onPostCreated: (post: Post) => void;
  onClose: () => void;
}

function PostComposerModalContent({ currentUser, onPostCreated, onClose }: PostComposerModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 2000,
      }}
      onClick={handleOverlayClick}
    >
      <div style={{
        background: 'var(--bg-primary)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '1.5rem', maxWidth: 520, width: '90%',
        maxHeight: '90vh', overflowY: 'auto', position: 'relative',
      }}>
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: '0.75rem', right: '0.75rem',
            background: 'none', border: 'none', fontSize: '1.25rem',
            cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1,
          }}
        >
          ✕
        </button>
        <PostComposer
          currentUser={currentUser}
          onPostCreated={onPostCreated}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

let rootInstance: Root | null = null;
let containerEl: HTMLElement | null = null;

export function openPostComposerModal(opts: {
  currentUser: { username: string; display_name?: string; avatar_key?: string } | null | undefined;
  onPostCreated: (post: Post) => void;
}): void {
  const unregister = registerModal();

  if (!containerEl) {
    containerEl = document.createElement('div');
    document.body.appendChild(containerEl);
  }

  const handleClose = () => {
    unregister();
    if (rootInstance && containerEl) {
      rootInstance.unmount();
      rootInstance = null;
      if (containerEl.parentNode) containerEl.remove();
      containerEl = null;
    }
  };

  rootInstance = createRoot(containerEl);
  rootInstance.render(
    <PostComposerModalContent
      currentUser={opts.currentUser}
      onPostCreated={(post) => {
        opts.onPostCreated(post);
        handleClose();
      }}
      onClose={handleClose}
    />
  );
}
