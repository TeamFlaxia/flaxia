'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { formatCount } from '@/lib/format';
import { getReplyStyle } from '@/lib/settings';
import { buildTree } from '@/lib/thread';
import type { PostNode } from '@/lib/thread';
import type { Post } from '@/types/post';
import PostCard from '@/components/client/PostCard';
import ReplyComposer from '@/components/client/ReplyComposer';
import { LeftNav } from '@/components/client/LeftNav';
import { RightPanel } from '@/components/client/RightPanel';

function ReplyNodeComponent({
  node,
  sandboxOrigin,
  currentUser,
  postIndex,
}: {
  node: PostNode;
  sandboxOrigin: string;
  currentUser?: { username: string; id: string; display_name?: string; avatar_key?: string } | null;
  postIndex: number;
}) {
  return (
    <div className="reply-node" style={{ marginLeft: '1rem', borderLeft: '2px solid var(--border-color, #e2e8f0)', paddingLeft: '0.75rem' }}>
      <PostCard
        post={node.post}
        sandboxOrigin={sandboxOrigin}
        currentUser={currentUser}
        depth={node.post.depth}
        disableNavigation
        postIndex={postIndex}
        enablePostRefs
      />
      {node.children.length > 0 && (
        <div className="reply-children">
          {node.children.map((child, idx) => (
            <ReplyNodeComponent
              key={child.post.id}
              node={child}
              sandboxOrigin={sandboxOrigin}
              currentUser={currentUser}
              postIndex={postIndex + idx + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ThreadPageClient({ postId }: { postId: string }) {
  const router = useRouter();
  const { currentUser } = useAuth();
  const { t } = useI18n();

  const [root, setRoot] = useState<Post | null>(null);
  const [replies, setReplies] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showReplyComposer, setShowReplyComposer] = useState(false);

  const repliesContentRef = useRef<HTMLDivElement>(null);
  const postIdToIndex = useRef(new Map<string, number>());

  const sandboxOrigin = process.env.NEXT_PUBLIC_SANDBOX_ORIGIN || 'http://localhost:3001';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/posts/${postId}/thread`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load thread');
        return res.json() as Promise<{ root: Post; replies: Post[] }>;
      })
      .then(data => {
        if (cancelled) return;
        setRoot(data.root);
        setReplies(data.replies);
        window.dispatchEvent(new CustomEvent('postUpdated', {
          detail: { postId, replyCount: data.replies.length },
        }));
        const map = new Map<string, number>();
        data.replies.forEach((p, i) => map.set(p.id, i + 1));
        postIdToIndex.current = map;
      })
      .catch(err => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [postId]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleReplyRefClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const refLink = target.classList.contains('post-ref-link')
      ? target
      : target.closest('.post-ref-link') as HTMLElement | null;
    if (refLink) {
      e.preventDefault();
      const index = refLink.dataset.postIndex;
      if (index) {
        const targetPost = repliesContentRef.current?.querySelector(`[data-post-index="${index}"]`);
        if (targetPost) {
          targetPost.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
  }, []);

  const repliesRef = useRef(replies);
  repliesRef.current = replies;

  const handleReplyCreated = useCallback((newReply: Post) => {
    setReplies(prev => {
      const updated = [...prev, newReply];
      window.dispatchEvent(new CustomEvent('postUpdated', {
        detail: { postId, replyCount: updated.length },
      }));
      setTimeout(() => {
        const el = repliesContentRef.current?.querySelector(`[data-post-index="${updated.length}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
      return updated;
    });
    setShowReplyComposer(false);
  }, [postId]);

  const replyStyle = typeof window !== 'undefined' ? getReplyStyle() : '2ch';

  return (
    <div className="main-container" style={{ background: '#ffffff', minHeight: '100vh' }}>
      <LeftNav activeItem="home" />
      <main className="main-content thread-main-content" style={{ flex: 1, padding: '1rem' }}>
        <div
          style={{
            position: 'sticky', top: 0, zIndex: 10,
            background: '#ffffff', borderBottom: '1px solid #e2e8f0',
            marginBottom: '1rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', padding: '0.5rem 0 1rem' }}>
            <button
              onClick={handleBack}
              style={{
                background: 'none', border: 'none', color: '#22c55e',
                fontFamily: "'Noto Sans', monospace, sans-serif",
                fontSize: '1rem', cursor: 'pointer', padding: '0.5rem', marginRight: '1rem',
              }}
            >
              {t('common.back')}
            </button>
            <h1 style={{ color: '#0f172a', fontSize: '1.25rem', margin: 0, fontWeight: 'normal', fontFamily: "'Noto Sans', monospace, sans-serif" }}>
              {t('thread.title')}
            </h1>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '4rem 2rem', color: '#64748b' }}>
            {t('thread.loading')}
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '4rem 2rem', color: '#ef4444' }}>
            {error}
          </div>
        ) : root ? (
          <>
            <div className="thread-root-post-container">
              <PostCard
                post={root}
                sandboxOrigin={sandboxOrigin}
                currentUser={currentUser}
                depth={root.depth}
                disableReplyComposer
                onReplyToggle={() => setShowReplyComposer(v => !v)}
              />

              {showReplyComposer && (
                <ReplyComposer
                  postId={postId}
                  onReplyCreated={handleReplyCreated}
                  onCancel={() => setShowReplyComposer(false)}
                />
              )}
            </div>

            <div
              ref={repliesContentRef}
              className="thread-replies-content"
              onClick={handleReplyRefClick}
            >
              <h2
                id="thread-replies-header"
                style={{
                  color: '#64748b', fontSize: '1rem', margin: '0 0 1rem',
                  paddingTop: '1rem', fontWeight: 'normal',
                  fontFamily: "'Noto Sans', monospace, sans-serif",
                }}
              >
                {t('thread.replies_header', { count: formatCount(replies.length) })}
              </h2>

              {replies.length > 0 ? (
                <div className="replies-container">
                  {replyStyle === 'twitter' ? (
                    buildTree(replies).map((node, idx) => (
                      <ReplyNodeComponent
                        key={node.post.id}
                        node={node}
                        sandboxOrigin={sandboxOrigin}
                        currentUser={currentUser}
                        postIndex={idx + 1}
                      />
                    ))
                  ) : (
                    replies.map((reply, idx) => (
                      <PostCard
                        key={reply.id}
                        post={reply}
                        sandboxOrigin={sandboxOrigin}
                        currentUser={currentUser}
                        depth={reply.depth}
                        disableNavigation
                        postIndex={idx + 1}
                        enablePostRefs
                      />
                    ))
                  )}
                </div>
              ) : (
                <p style={{ color: '#64748b', textAlign: 'center', padding: '2rem', fontStyle: 'italic' }}>
                  {t('thread.no_replies')}
                </p>
              )}
            </div>
          </>
        ) : null}
      </main>
      <RightPanel />
    </div>
  );
}
