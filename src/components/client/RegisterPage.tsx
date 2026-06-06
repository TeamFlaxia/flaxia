'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';

export function RegisterPage() {
  const router = useRouter();
  const { login } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [consented, setConsented] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const validate = (): boolean => {
    const errs: Record<string, string> = {};

    if (!email) errs.email = t('register.error_email_required');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = t('register.error_email_invalid');

    if (!username) errs.username = t('register.error_username_required');
    else if (!/^[a-zA-Z0-9_]{1,20}$/.test(username)) errs.username = t('register.error_username_invalid');

    if (!displayName) errs.displayName = t('register.error_display_name_required');
    else if (displayName.length > 50) errs.displayName = t('register.error_display_name_length');

    if (!password) errs.password = t('register.error_password_required');
    else if (password.length < 8 || password.length > 128) errs.password = t('register.error_password_length');

    if (!confirmPassword) errs.confirmPassword = t('register.error_confirm_password');
    else if (password !== confirmPassword) errs.confirmPassword = t('register.error_password_mismatch');

    setErrors(errs);
    return Object.keys(errs).length === 0 && consented;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setSubmitting(true);
    setErrors({});

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
          username: username.trim(),
          display_name: displayName.trim(),
        }),
      });

      if (res.ok) {
        const data = await res.json() as { sessionId?: string };
        if (data.sessionId) {
          localStorage.setItem('flaxia_session', data.sessionId);
        }
        await login(data.sessionId || '');
        router.push('/arcade');
      } else {
        const data = await res.json() as { error?: string };
        const msg = data.error || t('register.error_general');
        if (msg.toLowerCase().includes('email')) {
          setErrors({ email: msg });
        } else if (msg.toLowerCase().includes('username')) {
          setErrors({ username: msg });
        } else {
          setErrors({ email: msg });
        }
      }
    } catch {
      setErrors({ email: t('register.error_network') });
    } finally {
      setSubmitting(false);
    }
  };

  const isFormValid = email && username && displayName && password && confirmPassword && consented
    && password === confirmPassword && password.length >= 8;

  return (
    <div className="auth-page">
      <div className="auth-card">
        <button className="auth-back" onClick={() => router.push('/')}>
          ← {t('auth.back')}
        </button>
        <div className="auth-logo">{t('register.title')}</div>
        <h1 className="auth-heading">{t('register.heading')}</h1>
        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <input className="auth-input" type="email" placeholder={t('register.email_placeholder')} required
              value={email} onChange={(e) => setEmail(e.target.value)} />
            {errors.email && <div className="field-error" style={{ display: 'block' }}>{errors.email}</div>}
          </div>
          <div className="form-group">
            <input className="auth-input" type="text" placeholder={t('register.username_placeholder')} required
              value={username} onChange={(e) => setUsername(e.target.value)} />
            <div className="field-hint">{t('register.username_hint')}</div>
            {errors.username && <div className="field-error" style={{ display: 'block' }}>{errors.username}</div>}
          </div>
          <div className="form-group">
            <input className="auth-input" type="text" placeholder={t('register.display_name_placeholder')} required
              value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            {errors.displayName && <div className="field-error" style={{ display: 'block' }}>{errors.displayName}</div>}
          </div>
          <div className="form-group">
            <input className="auth-input" type="password" placeholder={t('register.password_placeholder')} required
              value={password} onChange={(e) => setPassword(e.target.value)} />
            {errors.password && <div className="field-error" style={{ display: 'block' }}>{errors.password}</div>}
          </div>
          <div className="form-group">
            <input className="auth-input" type="password" placeholder={t('register.confirm_password_placeholder')} required
              value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            {errors.confirmPassword && <div className="field-error" style={{ display: 'block' }}>{errors.confirmPassword}</div>}
          </div>
          <div className="form-group consent-group">
            <label className="consent-label">
              <input className="consent-checkbox" type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
              <span className="consent-text">{t('register.agree_terms')}</span>
            </label>
          </div>
          <button type="submit" className="auth-button" disabled={!isFormValid || submitting}>
            {submitting ? t('register.submitting') : t('register.submit')}
          </button>
        </form>
        <div className="auth-link">
          <a href="#" onClick={(e) => { e.preventDefault(); router.push('/login'); }}>
            {t('register.login_link')}
          </a>
        </div>
      </div>
    </div>
  );
}
