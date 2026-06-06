'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/_providers/AuthContext';
import { useI18n } from '@/app/_providers/I18nContext';

export function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isValid = email.trim() !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && password.trim() !== '';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setSubmitting(true);
    setError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password: password.trim() }),
      });
      const data = await res.json() as { error?: string; sessionId?: string };

      if (res.ok && data.sessionId) {
        await login(data.sessionId);
        router.push('/arcade');
      } else {
        setError(data.error || t('login.error_invalid'));
      }
    } catch {
      setError(t('login.error_network'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <button className="auth-back" onClick={() => router.push('/')}>
          ← {t('auth.back')}
        </button>
        <div className="auth-logo">{t('login.title')}</div>
        <h1 className="auth-heading">{t('login.heading')}</h1>
        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <input
              className="auth-input"
              type="email"
              placeholder={t('login.email_placeholder')}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="form-group">
            <input
              className="auth-input"
              type="password"
              placeholder={t('login.password_placeholder')}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <div className="auth-error" style={{ display: 'block' }}>{error}</div>}
          <button type="submit" className="auth-button" disabled={!isValid || submitting}>
            {submitting ? t('login.submitting') : t('login.submit')}
          </button>
        </form>
        <div className="legal-notice">{t('login.agree_terms')}</div>
        <div className="auth-link">
          <a href="#" onClick={(e) => { e.preventDefault(); router.push('/register'); }}>
            {t('login.register_link')}
          </a>
        </div>
      </div>
    </div>
  );
}
