'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';
import { clearMeCache } from '@/lib/auth-cache';
import { getReplyStyle, setReplyStyle } from '@/lib/settings';
import { getLocale, setLocale } from '@/lib/i18n';
import { registerModal } from '@/lib/modal-state';

export default function SettingsPage() {
  const { currentUser } = useAuth();
  const { t } = useI18n();
  const [locales, setLocales] = useState<string[]>(['en', 'ja']);
  const [selectedLocale, setSelectedLocale] = useState(getLocale());
  const [replyStyle, setReplyStyleState] = useState(getReplyStyle());
  const [emailForm, setEmailForm] = useState({ currentPassword: '', newEmail: '' });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [emailMessage, setEmailMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [langSaving, setLangSaving] = useState(false);
  const passwordFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    fetch('/locales/index.json')
      .then(r => r.ok ? r.json() as Promise<string[]> : ['en', 'ja'])
      .then(setLocales)
      .catch(() => setLocales(['en', 'ja']));
  }, []);

  const handleLocaleChange = useCallback(async (locale: string) => {
    setSelectedLocale(locale);
    setLangSaving(true);
    try {
      await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ language: locale }),
      });
      setLocale(locale);
      window.location.reload();
    } catch { setLangSaving(false); }
  }, []);

  const handleReplyStyleChange = useCallback((style: 'twitter' | '2ch') => {
    setReplyStyleState(style);
    setReplyStyle(style);
  }, []);

  const handleEmailSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailMessage(null);
    try {
      const res = await fetch('/api/users/me/email', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(emailForm),
      });
      if (res.ok) {
        setEmailMessage({ type: 'success', text: t('settings.email_success') });
        setEmailForm({ currentPassword: '', newEmail: '' });
      } else {
        const data = await res.json() as { error?: string };
        setEmailMessage({ type: 'error', text: data.error || t('settings.email_failed') });
      }
    } catch { setEmailMessage({ type: 'error', text: t('settings.email_failed') }); }
  }, [emailForm, t]);

  const handlePasswordSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMessage(null);
    if (passwordForm.newPassword.length < 8 || passwordForm.newPassword.length > 128) {
      setPasswordMessage({ type: 'error', text: t('settings.password_length_error') });
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordMessage({ type: 'error', text: t('settings.password_mismatch') });
      return;
    }
    try {
      const res = await fetch('/api/users/me/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ current_password: passwordForm.currentPassword, new_password: passwordForm.newPassword }),
      });
      if (res.ok) {
        setPasswordMessage({ type: 'success', text: t('settings.password_success') });
        setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      } else {
        const data = await res.json() as { error?: string };
        setPasswordMessage({ type: 'error', text: data.error || t('settings.password_failed') });
      }
    } catch { setPasswordMessage({ type: 'error', text: t('settings.password_failed') }); }
  }, [passwordForm, t]);

  const handleLogout = useCallback(() => {
    if (!currentUser) return;
    const overlay = document.createElement('div');
    const unregister = registerModal();
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000;';
    overlay.innerHTML = `
      <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:1.5rem;max-width:320px;width:90%;text-align:center;">
        <p style="margin:0 0 1rem;color:var(--text-primary);font-size:0.875rem;">${t('profile.logout_title', { username: currentUser.username })}</p>
        <div style="display:flex;gap:0.75rem;justify-content:center;">
          <button class="cancel-btn" style="padding:0.5rem 1rem;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:9999px;cursor:pointer;">${t('common.cancel')}</button>
          <button class="confirm-btn" style="padding:0.5rem 1rem;background:var(--text-primary);color:var(--bg-primary);border:none;border-radius:9999px;cursor:pointer;font-weight:600;">${t('auth.sign_out')}</button>
        </div>
      </div>`;
    overlay.querySelector('.cancel-btn')?.addEventListener('click', () => { unregister(); overlay.remove(); });
    overlay.querySelector('.confirm-btn')?.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        clearMeCache();
        window.location.href = '/';
      } catch { unregister(); overlay.remove(); }
    });
    document.body.appendChild(overlay);
  }, [currentUser, t]);

  return (
    <div className="settings-page" style={{ maxWidth: 600, margin: '0 auto', padding: '1rem' }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '1.5rem' }}>{t('settings.title')}</h1>

      {currentUser && (
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem' }}>{t('settings.account_section')}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: '1.25rem', ...(currentUser.avatar_key ? { backgroundImage: `url(/api/images/${currentUser.avatar_key})`, backgroundSize: 'cover', color: 'transparent' } : {}) }}>
              {!currentUser.avatar_key ? currentUser.username.charAt(0).toUpperCase() : ''}
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>{currentUser.display_name || currentUser.username}</div>
              <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>@{currentUser.username}</div>
            </div>
          </div>
          <button onClick={handleLogout} style={{ padding: '0.5rem 1rem', border: '1px solid var(--border)', borderRadius: 9999, background: 'none', cursor: 'pointer', color: 'var(--text-primary)' }}>
            {t('profile.log_out')}
          </button>
        </section>
      )}

      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem' }}>{t('settings.display_section')}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {(['twitter', '2ch'] as const).map(style => (
            <label key={style} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="radio"
                name="replyStyle"
                checked={replyStyle === style}
                onChange={() => handleReplyStyleChange(style)}
              />
              <span>{t(`settings.reply_style_${style}`)}</span>
            </label>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem' }}>{t('settings.language_section')}</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <select
            value={selectedLocale}
            onChange={e => handleLocaleChange(e.target.value)}
            disabled={langSaving}
            style={{ flex: 1, padding: '0.5rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
          >
            {locales.map(l => (
              <option key={l} value={l}>{l.toUpperCase()}</option>
            ))}
          </select>
          {langSaving && <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>{t('common.saving')}</span>}
        </div>
      </section>

      {currentUser && (
        <>
          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem' }}>{t('settings.email_section')}</h2>
            <form onSubmit={handleEmailSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <input
                type="password"
                placeholder={t('settings.current_password')}
                value={emailForm.currentPassword}
                onChange={e => setEmailForm(f => ({ ...f, currentPassword: e.target.value }))}
                required
                style={{ padding: '0.5rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              />
              <input
                type="email"
                placeholder={t('settings.new_email')}
                value={emailForm.newEmail}
                onChange={e => setEmailForm(f => ({ ...f, newEmail: e.target.value }))}
                required
                style={{ padding: '0.5rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              />
              <button type="submit" style={{ padding: '0.5rem 1rem', borderRadius: 4, border: 'none', background: 'var(--accent)', cursor: 'pointer', fontWeight: 600, alignSelf: 'flex-start' }}>
                {t('settings.save_email')}
              </button>
              {emailMessage && (
                <div style={{ fontSize: '0.875rem', color: emailMessage.type === 'success' ? '#22c55e' : '#ef4444' }}>
                  {emailMessage.text}
                </div>
              )}
            </form>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem', marginBottom: '1rem' }}>{t('settings.password_section')}</h2>
            <form ref={passwordFormRef} onSubmit={handlePasswordSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <input
                type="password"
                placeholder={t('settings.current_password')}
                value={passwordForm.currentPassword}
                onChange={e => setPasswordForm(f => ({ ...f, currentPassword: e.target.value }))}
                required
                style={{ padding: '0.5rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              />
              <input
                type="password"
                placeholder={t('settings.new_password')}
                value={passwordForm.newPassword}
                onChange={e => setPasswordForm(f => ({ ...f, newPassword: e.target.value }))}
                required
                minLength={8}
                maxLength={128}
                style={{ padding: '0.5rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              />
              <input
                type="password"
                placeholder={t('settings.confirm_password')}
                value={passwordForm.confirmPassword}
                onChange={e => setPasswordForm(f => ({ ...f, confirmPassword: e.target.value }))}
                required
                style={{ padding: '0.5rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              />
              <button type="submit" style={{ padding: '0.5rem 1rem', borderRadius: 4, border: 'none', background: 'var(--accent)', cursor: 'pointer', fontWeight: 600, alignSelf: 'flex-start' }}>
                {t('settings.save_password')}
              </button>
              {passwordMessage && (
                <div style={{ fontSize: '0.875rem', color: passwordMessage.type === 'success' ? '#22c55e' : '#ef4444' }}>
                  {passwordMessage.text}
                </div>
              )}
            </form>
          </section>
        </>
      )}
    </div>
  );
}
