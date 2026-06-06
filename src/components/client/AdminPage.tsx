'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { formatCount } from '@/lib/format';
import { showToast } from '@/lib/toast';
import { createConfirmDialog } from '@/lib/confirm-dialog';

// ---- Types ----

interface AdminAlert {
  id: string; post_id: string; category: string; priority: 'critical' | 'high' | 'normal';
  resolved: number; created_at: string; dmca_work_description?: string;
  dmca_reporter_email?: string; dmca_sworn?: number; post_text?: string; payload_key?: string;
}

interface HiddenPost {
  id: string; user_id: string; username: string; display_name: string;
  text: string; created_at: string; hidden: number; category?: string;
}

interface AdminUser {
  id: string; username: string; display_name: string; email: string; created_at: string;
}

interface AdminAd {
  id: string; title: string; ad_type: 'self_hosted' | 'admax';
  body_text: string; click_url: string | null; payload_key: string | null;
  payload_type: 'zip' | 'swf' | 'gif' | 'image' | null; thumbnail_key?: string;
  impressions: number; clicks: number; active: number; created_at: string;
  ctr?: number; interaction_count?: number;
}

interface CounterNotice {
  id: string; post_id: string; user_id: string; name: string; email: string;
  address: string; phone: string; statement: number; consent_jurisdiction: number;
  status: string; submitted_at: string; restore_at: string; username: string; display_name: string;
}

type AdminTab = 'alerts' | 'hidden' | 'users' | 'ads' | 'counter';

// ---- Helpers ----

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString();
}

// ---- Tab Components ----

function AlertsTab() {
  const { t } = useI18n();
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/alerts', { credentials: 'include' });
      if (res.status === 403) return [];
      if (!res.ok) throw new Error();
      const data = await res.json() as { alerts: AdminAlert[] };
      return data.alerts || [];
    } catch { return []; }
  }, []);

  useEffect(() => {
    fetchAlerts().then(a => { setAlerts(a); setLoading(false); });
  }, [fetchAlerts]);

  const resolveAlert = async (id: string) => {
    try {
      await fetch(`/api/admin/alerts/${id}/resolve`, { method: 'POST', credentials: 'include' });
      setAlerts(prev => prev.filter(a => a.id !== id));
    } catch {}
  };

  const hidePost = async (postId: string) => {
    try {
      await fetch(`/api/admin/posts/${postId}/hide`, { method: 'POST', credentials: 'include' });
      return true;
    } catch { return false; }
  };

  if (loading) return <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>{t('common.loading')}</div>;

  return (
    <div style={{ maxWidth: 800 }}>
      <h2 style={{ color: '#f1f5f9', fontSize: 24, fontWeight: 600, marginBottom: 24 }}>{t('admin_alerts.title')}</h2>
      {alerts.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 14, padding: 24, textAlign: 'center' }}>{t('admin_alerts.empty')}</div>
      ) : alerts.map(alert => {
        const priorityColor = alert.priority === 'critical' ? '#ef4444' : alert.priority === 'high' ? '#f59e0b' : '#94a3b8';
        const prefix = alert.priority === 'critical' ? '🚨' : alert.priority === 'high' ? '⚠' : '•';
        return (
          <div key={alert.id} style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={{ color: priorityColor, fontWeight: 600, fontSize: 14 }}>{prefix} {alert.priority.toUpperCase()}</span>
              <span style={{ color: '#94a3b8', fontSize: 14 }}>{alert.category}</span>
              <span style={{ color: '#94a3b8', fontSize: 14 }}>post: {alert.post_id}</span>
              <span style={{ color: '#64748b', fontSize: 14, marginLeft: 'auto' }}>{timeAgo(alert.created_at)}</span>
            </div>
            {alert.category === 'copyright' && alert.dmca_work_description && (
              <div style={{ background: '#0f172a', borderRadius: 4, padding: 12, marginBottom: 12, fontSize: 13, color: '#94a3b8' }}>
                <div>Work: "{alert.dmca_work_description}"</div>
                <div>Email: "{alert.dmca_reporter_email}"</div>
                <div style={{ marginTop: 4 }}>Sworn: {alert.dmca_sworn ? '✓' : '✗'}</div>
              </div>
            )}
            {(alert.category === 'csam' || alert.category === 'malware') && (
              <div style={{ background: '#451a1a', border: '1px solid #ef4444', borderRadius: 4, padding: 12, marginBottom: 12, fontSize: 13, color: '#f1f5f9' }}>
                <div style={{ marginBottom: 8 }}>{t('admin_alerts.warning_csam')}</div>
                <code style={{ background: '#0f172a', padding: 8, borderRadius: 4, display: 'block', overflowX: 'auto' }}>
                  wrangler r2 object delete flaxia-content --key "{alert.payload_key || ''}"
                </code>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {alert.category !== 'csam' && alert.category !== 'malware' && (
                <button onClick={() => window.open(`/posts/${alert.post_id}`, '_blank')}
                  style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                  {t('admin_alerts.view_post')}
                </button>
              )}
              <button onClick={async () => {
                if (!await createConfirmDialog(t('admin_alerts.hide_confirm'))) return;
                if (await hidePost(alert.post_id)) await resolveAlert(alert.id);
              }}
                style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                {t('admin_alerts.hide')}
              </button>
              <button onClick={() => resolveAlert(alert.id)}
                style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
                {t('admin_alerts.dismiss')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HiddenTab() {
  const { t } = useI18n();
  const [posts, setPosts] = useState<HiddenPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/posts/hidden', { credentials: 'include' })
      .then(r => r.json() as Promise<{ posts: HiddenPost[] }>)
      .then(d => { setPosts(d.posts || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const unhidePost = async (postId: string) => {
    try {
      const res = await fetch(`/api/admin/posts/${postId}/unhide`, { method: 'POST', credentials: 'include' });
      if (res.ok) { setPosts(prev => prev.filter(p => p.id !== postId)); return true; }
    } catch {}
    return false;
  };

  if (loading) return <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>{t('common.loading')}</div>;

  return (
    <div style={{ maxWidth: 800 }}>
      <h2 style={{ color: '#f1f5f9', fontSize: 24, fontWeight: 600, marginBottom: 24 }}>{t('admin_hidden.title')}</h2>
      {posts.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 14, padding: 24, textAlign: 'center' }}>{t('admin_hidden.empty')}</div>
      ) : posts.map(post => (
        <div key={post.id} style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ color: '#94a3b8', fontSize: 13, fontFamily: 'monospace' }}>post_id: {post.id}</span>
            <span style={{ color: '#22c55e', fontSize: 14, fontWeight: 500 }}>@{post.username}</span>
            <span style={{ color: '#94a3b8', fontSize: 14 }}>{post.category || 'unknown'}</span>
            <span style={{ color: '#64748b', fontSize: 13, marginLeft: 'auto' }}>{timeAgo(post.created_at)}</span>
          </div>
          <div style={{ color: '#cbd5e1', fontSize: 14, marginBottom: 12, lineHeight: 1.5 }}>
            "{post.text.length > 50 ? post.text.substring(0, 50) + '...' : post.text}"
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => window.open(`/posts/${post.id}`, '_blank')}
              style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
              {t('admin_hidden.view')}
            </button>
            <button onClick={async () => {
              if (!await createConfirmDialog(t('admin_hidden.restore_confirm'))) return;
              await unhidePost(post.id);
            }}
              style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
              {t('admin_hidden.unhide')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function UsersTab() {
  const { t } = useI18n();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const adminUsernames = ['admin']; // TODO: fetch from config

  useEffect(() => {
    fetch('/api/admin/users', { credentials: 'include' })
      .then(r => r.json() as Promise<{ users: AdminUser[] }>)
      .then(d => { setUsers(d.users || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const deleteUser = async (userId: string) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) { const err = await res.json() as { error?: string }; throw new Error(err.error); }
      setUsers(prev => prev.filter(u => u.id !== userId));
      return true;
    } catch { return false; }
  };

  const filtered = searchQuery.trim()
    ? users.filter(u => u.username.toLowerCase().includes(searchQuery.toLowerCase()) || u.email.toLowerCase().includes(searchQuery.toLowerCase()))
    : users;

  if (loading) return <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>{t('common.loading')}</div>;

  return (
    <div style={{ maxWidth: 900 }}>
      <h2 style={{ color: '#f1f5f9', fontSize: 24, fontWeight: 600, marginBottom: 16 }}>{t('admin_users.title')}</h2>
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 16, color: '#f1f5f9' }}>
          <span style={{ color: '#94a3b8', fontWeight: 500 }}>{t('admin_users.total_users')}</span>
          <span style={{ color: '#22c55e', fontWeight: 600, fontSize: 18 }}>{formatCount(users.length)}</span>
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
          placeholder={t('admin_users.search_placeholder')}
          style={{ width: '100%', maxWidth: 300, padding: '10px 14px', background: '#1e293b', border: '1px solid #334155', borderRadius: 6, color: '#f1f5f9', fontSize: 14 }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', background: '#0f172a', borderRadius: '8px 8px 0 0', gap: 12, fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        <span style={{ minWidth: 150 }}>{t('admin_users.header_username')}</span>
        <span style={{ minWidth: 120 }}>{t('admin_users.header_display_name')}</span>
        <span style={{ minWidth: 200 }}>{t('admin_users.header_email')}</span>
        <span style={{ marginLeft: 'auto' }}>{t('admin_users.header_joined')}</span>
      </div>
      <div style={{ background: '#1e293b', borderRadius: '0 0 8px 8px' }}>
        {filtered.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 14, padding: 24, textAlign: 'center' }}>
            {searchQuery ? t('admin_users.no_results') : t('admin_users.empty')}
          </div>
        ) : filtered.map(user => {
          const isAdmin = adminUsernames.includes(user.username);
          return (
            <div key={user.id} style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid #1e293b', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ color: '#22c55e', fontSize: 14, fontWeight: 500, minWidth: 150 }}>@{user.username}</span>
              <span style={{ color: '#f1f5f9', fontSize: 14, minWidth: 120 }}>{user.display_name}</span>
              <span style={{ color: '#94a3b8', fontSize: 14, minWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</span>
              <span style={{ color: '#64748b', fontSize: 13, marginLeft: 'auto' }}>{fmtDate(user.created_at)}</span>
              {isAdmin ? (
                <span style={{ background: '#22c55e20', color: '#22c55e', border: '1px solid #22c55e40', padding: '4px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
                  {t('admin_users.admin_badge')}
                </span>
              ) : (
                <button onClick={async () => {
                  if (!await createConfirmDialog(t('admin_users.delete_confirm', { username: user.username }))) return;
                  await deleteUser(user.id);
                }}
                  style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>
                  {t('admin_users.delete_account')}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdsTab() {
  const { t } = useI18n();
  const [ads, setAds] = useState<AdminAd[]>([]);
  const [everyN, setEveryN] = useState(8);
  const [loading, setLoading] = useState(true);
  const [editingAd, setEditingAd] = useState<AdminAd | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/ads', { credentials: 'include' }).then(r => r.json() as Promise<{ ads: AdminAd[] }>).then(d => d.ads || []).catch(() => []),
      fetch('/api/admin/ads/config', { credentials: 'include' }).then(r => r.json() as Promise<{ every_n: number }>).then(d => d.every_n).catch(() => 8),
    ]).then(([adsData, everyNData]) => { setAds(adsData); setEveryN(everyNData); setLoading(false); });
  }, []);

  const toggleActive = async (adId: string, active: number) => {
    try {
      await fetch(`/api/admin/ads/${adId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: active ? 0 : 1 }), credentials: 'include' });
      setAds(prev => prev.map(a => a.id === adId ? { ...a, active: active ? 0 : 1 } : a));
    } catch {}
  };

  const deleteAd = async (adId: string) => {
    if (!await createConfirmDialog(t('admin_ads.delete_confirm'))) return;
    try {
      await fetch(`/api/admin/ads/${adId}`, { method: 'DELETE', credentials: 'include' });
      setAds(prev => prev.filter(a => a.id !== adId));
    } catch {}
  };

  if (loading) return <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>{t('common.loading')}</div>;

  return (
    <div style={{ maxWidth: 1200 }}>
      {/* Settings */}
      <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 24 }}>
        <h3 style={{ color: '#f1f5f9', fontSize: 18, fontWeight: 600, marginBottom: 16 }}>{t('admin_ads.global_settings')}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ color: '#94a3b8', fontSize: 14 }}>{t('admin_ads.every_n_label')}</label>
          <input type="number" min={1} value={everyN} onChange={e => setEveryN(parseInt(e.target.value) || 1)}
            style={{ background: '#0f172a', border: '1px solid #334155', color: '#f1f5f9', padding: '8px 12px', borderRadius: 4, fontSize: 14, width: 80 }} />
          <button onClick={async () => {
            const res = await fetch('/api/admin/ads/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ every_n: everyN }), credentials: 'include' });
            showToast(res.ok ? t('admin_ads.settings_saved') : t('admin_ads.settings_save_failed'), !res.ok);
          }}
            style={{ background: '#22c55e', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 14 }}>
            {t('common.save')}
          </button>
        </div>
      </div>

      {/* Ad list */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ color: '#f1f5f9', fontSize: 18, fontWeight: 600, margin: 0 }}>{t('admin_ads.ad_list')}</h3>
          <button onClick={() => { setEditingAd(null); setShowModal(true); }}
            style={{ background: '#22c55e', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 14, fontWeight: 500 }}>
            {t('admin_ads.new_ad')}
          </button>
        </div>

        {ads.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 14, padding: 24, textAlign: 'center', background: '#1e293b', borderRadius: 8 }}>{t('admin_ads.no_ads')}</div>
        ) : (
          <div style={{ background: '#1e293b', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 80px 100px 100px 80px 120px 120px 80px', gap: 1, background: '#0f172a', padding: '12px 16px', fontSize: '0.875rem', color: '#94a3b8' }}>
              <div>{t('admin_ads.header_title')}</div><div>{t('admin_ads.header_type')}</div><div>{t('admin_ads.header_format')}</div>
              <div>{t('admin_ads.header_active')}</div><div>{t('admin_ads.header_impressions')}</div><div>{t('admin_ads.header_clicks')}</div>
              <div>{t('admin_ads.header_ctr')}</div><div>{t('admin_ads.header_plays')}</div><div>{t('admin_ads.header_age')}</div><div>{t('admin_ads.header_actions')}</div>
            </div>
            {ads.map(ad => (
              <div key={ad.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 80px 100px 100px 80px 120px 120px 80px', gap: 1, padding: '12px 16px', alignItems: 'center', fontSize: 13, color: '#cbd5e1', borderBottom: '1px solid #0f172a' }}>
                <div>{ad.title}</div>
                <div>{ad.ad_type}</div>
                <div>{ad.payload_type || '-'}</div>
                <div>
                  <button onClick={() => toggleActive(ad.id, ad.active)}
                    style={{ background: ad.active ? '#22c55e' : '#64748b', border: 'none', width: 20, height: 20, borderRadius: 4, cursor: 'pointer' }} />
                </div>
                <div>{formatCount(ad.impressions)}</div>
                <div>{formatCount(ad.clicks)}</div>
                <div>{ad.ctr ? `${(ad.ctr * 100).toFixed(1)}%` : '-'}</div>
                <div>{ad.interaction_count ? formatCount(ad.interaction_count) : '-'}</div>
                <div>{timeAgo(ad.created_at)}</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => { setEditingAd(ad); setShowModal(true); }}
                    style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                    {t('admin_ads.edit')}
                  </button>
                  <button onClick={() => deleteAd(ad.id)}
                    style={{ background: '#991b1b', color: '#f1f5f9', border: 'none', padding: '4px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                    {t('admin_ads.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create/Edit modal - simplified */}
      {showModal && (
        <AdFormModal
          ad={editingAd}
          onClose={() => setShowModal(false)}
          onSaved={(ad) => {
            setAds(prev => editingAd ? prev.map(a => a.id === ad.id ? ad : a) : [...prev, ad]);
            setShowModal(false);
          }}
        />
      )}
    </div>
  );
}

function AdFormModal({ ad, onClose, onSaved }: { ad: AdminAd | null; onClose: () => void; onSaved: (ad: AdminAd) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(ad?.title || '');
  const [bodyText, setBodyText] = useState(ad?.body_text || '');
  const [clickUrl, setClickUrl] = useState(ad?.click_url || '');
  const [adType, setAdType] = useState<'self_hosted' | 'admax'>(ad?.ad_type || 'self_hosted');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || !bodyText.trim()) { showToast(t('admin_ads.validation_required'), true); return; }
    setSubmitting(true);
    try {
      const url = ad ? `/api/admin/ads/${ad.id}` : '/api/admin/ads';
      const method = ad ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body_text: bodyText.trim(), click_url: clickUrl || null, ad_type: adType }),
        credentials: 'include',
      });
      if (!res.ok) { showToast(t('admin_ads.save_failed'), true); return; }
      const data = await res.json() as { ad: AdminAd };
      showToast(t('admin_ads.saved'));
      onSaved(data.ad);
    } catch { showToast(t('admin_ads.save_failed'), true); }
    finally { setSubmitting(false); }
  };

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#1e293b', borderRadius: 12, padding: 24, maxWidth: 500, width: '90%', maxHeight: '80vh', overflowY: 'auto' }}>
        <h3 style={{ color: '#f1f5f9', fontSize: 18, fontWeight: 600, marginBottom: 16 }}>
          {ad ? t('admin_ads.edit_ad') : t('admin_ads.new_ad')}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('admin_ads.title_placeholder')}
            style={{ padding: 10, background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: '#f1f5f9', fontSize: 14 }} />
          <textarea value={bodyText} onChange={e => setBodyText(e.target.value)} placeholder={t('admin_ads.body_placeholder')} rows={4}
            style={{ padding: 10, background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: '#f1f5f9', fontSize: 14, resize: 'vertical' }} />
          <input value={clickUrl} onChange={e => setClickUrl(e.target.value)} placeholder={t('admin_ads.click_url_placeholder')}
            style={{ padding: 10, background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: '#f1f5f9', fontSize: 14 }} />
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ color: '#94a3b8', fontSize: 14, display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="radio" name="adType" checked={adType === 'self_hosted'} onChange={() => setAdType('self_hosted')} />
              {t('admin_ads.type_self_hosted')}
            </label>
            <label style={{ color: '#94a3b8', fontSize: 14, display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="radio" name="adType" checked={adType === 'admax'} onChange={() => setAdType('admax')} />
              {t('admin_ads.type_admax')}
            </label>
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={onClose}
              style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 14 }}>
              {t('common.cancel')}
            </button>
            <button onClick={handleSubmit} disabled={submitting}
              style={{ background: '#22c55e', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: submitting ? 'not-allowed' : 'pointer', fontSize: 14, opacity: submitting ? 0.6 : 1 }}>
              {submitting ? t('admin_ads.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CounterTab() {
  const { t } = useI18n();
  const [notices, setNotices] = useState<CounterNotice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/counter/pending', { credentials: 'include' })
      .then(r => r.json() as Promise<{ counter_notices: CounterNotice[] }>)
      .then(d => { setNotices(d.counter_notices || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const rejectCounter = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/counter/${id}/reject`, { method: 'POST', credentials: 'include' });
      if (res.ok) setNotices(prev => prev.filter(c => c.id !== id));
    } catch {}
  };

  if (loading) return <div style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>{t('common.loading')}</div>;

  return (
    <div style={{ maxWidth: 800 }}>
      <h2 style={{ color: '#f1f5f9', fontSize: 24, fontWeight: 600, marginBottom: 24 }}>{t('admin_counter.title')}</h2>
      {notices.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 14, padding: 24, textAlign: 'center' }}>{t('admin_counter.empty')}</div>
      ) : notices.map(cn => (
        <div key={cn.id} style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ color: '#f59e0b', fontWeight: 600, fontSize: 14 }}>⚠ COUNTER</span>
            <span style={{ color: '#22c55e', fontSize: 14 }}>@{cn.username}</span>
            <span style={{ color: '#94a3b8', fontSize: 14 }}>{t('admin_counter.submitted')}: {fmtDate(cn.submitted_at)}</span>
            <span style={{ color: '#64748b', fontSize: 14, marginLeft: 'auto' }}>{t('admin_counter.restore_at')}: {fmtDate(cn.restore_at)}</span>
          </div>
          <div style={{ background: '#0f172a', borderRadius: 4, padding: 12, marginBottom: 12, fontSize: 13, color: '#94a3b8' }}>
            <div><strong style={{ color: '#cbd5e1' }}>{t('admin_counter.name')}:</strong> {cn.name}</div>
            <div><strong style={{ color: '#cbd5e1' }}>{t('admin_counter.email')}:</strong> {cn.email}</div>
            <div><strong style={{ color: '#cbd5e1' }}>{t('admin_counter.address')}:</strong> {cn.address}</div>
            <div><strong style={{ color: '#cbd5e1' }}>{t('admin_counter.phone')}:</strong> {cn.phone}</div>
            <div style={{ marginTop: 8, color: cn.statement ? '#22c55e' : '#ef4444' }}>{cn.statement ? '✓' : '✗'} {t('admin_counter.statement')}</div>
            <div style={{ color: cn.consent_jurisdiction ? '#22c55e' : '#ef4444' }}>{cn.consent_jurisdiction ? '✓' : '✗'} {t('admin_counter.consent')}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => window.open(`/posts/${cn.post_id}`, '_blank')}
              style={{ background: '#334155', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
              {t('admin_counter.view_post')}
            </button>
            <button onClick={async () => {
              if (!await createConfirmDialog(t('admin_counter.reject_confirm'))) return;
              await rejectCounter(cn.id);
            }}
              style={{ background: '#991b1b', color: '#f1f5f9', border: 'none', padding: '8px 16px', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
              {t('admin_counter.reject')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Main Admin Page ----

export default function AdminPage({ tab: initialTab }: { tab?: string }) {
  const { currentUser } = useAuth();
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<AdminTab>((initialTab as AdminTab) || 'alerts');

  const tabs: { id: AdminTab; label: string }[] = [
    { id: 'alerts', label: t('admin_layout.tab_alerts') },
    { id: 'counter', label: t('admin_layout.tab_counter') },
    { id: 'hidden', label: t('admin_layout.tab_hidden') },
    { id: 'users', label: t('admin_layout.tab_users') },
    { id: 'ads', label: t('admin_layout.tab_ads') },
  ];

  const isAdmin = currentUser?.username === 'admin'; // Basic check

  if (!isAdmin) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f172a', color: '#f1f5f9', fontFamily: "'Noto Sans', monospace, sans-serif", padding: 48, textAlign: 'center', fontSize: 18 }}>
        {t('admin_layout.access_denied')}
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', color: '#f1f5f9', fontFamily: "'Noto Sans', monospace, sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #1e293b' }}>
        <a href="/home" style={{ color: '#22c55e', textDecoration: 'none', fontSize: 20, fontWeight: 600 }}>{t('admin_layout.title')}</a>
        <a href="/home" style={{ color: '#94a3b8', textDecoration: 'none', fontSize: 14, transition: 'color 0.2s' }}
          onMouseEnter={e => (e.currentTarget.style.color = '#f1f5f9')} onMouseLeave={e => (e.currentTarget.style.color = '#94a3b8')}>
          {t('admin_layout.back')}
        </a>
      </div>
      <div style={{ display: 'flex', minHeight: 'calc(100vh - 65px)' }}>
        <div style={{ width: 200, borderRight: '1px solid #1e293b', padding: '16px 0', flexShrink: 0 }}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              style={{
                width: '100%', padding: '12px 24px', background: 'transparent', border: 'none',
                color: activeTab === tab.id ? '#22c55e' : '#94a3b8', fontWeight: activeTab === tab.id ? 600 : 400,
                fontSize: 14, textAlign: 'left', cursor: 'pointer', transition: 'all 0.2s',
              }}>
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
          {activeTab === 'alerts' && <AlertsTab />}
          {activeTab === 'hidden' && <HiddenTab />}
          {activeTab === 'users' && <UsersTab />}
          {activeTab === 'ads' && <AdsTab />}
          {activeTab === 'counter' && <CounterTab />}
        </div>
      </div>
    </div>
  );
}
