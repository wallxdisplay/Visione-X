import { sendEmailVerification } from 'firebase/auth';
import { Alert, Button } from '@wallx-play/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { FullPageSpinner, safeNext } from '../../auth/guards';
import { errorMessage } from '../../lib/api';
import { AuthLayout } from './AuthLayout';

export function VerifyEmail() {
  const { t } = useTranslation();
  const { user, loading, refresh, signOut } = useAuth();
  const [params] = useSearchParams();
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/signin" replace />;
  if (user.emailVerified) return <Navigate to={safeNext(params.get('next'))} replace />;

  async function resend() {
    setBusy(true);
    try {
      await sendEmailVerification(user!, { url: window.location.href });
      setMessage({ tone: 'info', text: t('auth.verify.resent') });
    } catch (err) {
      setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    await refresh();
    setBusy(false);
    if (!user!.emailVerified) setMessage({ tone: 'info', text: t('auth.verify.notYet') });
  }

  return (
    <AuthLayout
      title={t('auth.verify.title')}
      description={t('auth.verify.description', { email: user.email })}
      footer={
        <button type="button" className="auth__link-btn" onClick={() => void signOut()}>
          {t('shell.signOut')}
        </button>
      }
    >
      <div className="wxp-form">
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <Button variant="primary" disabled={busy} onClick={() => void check()}>
          {t('auth.verify.done')}
        </Button>
        <Button disabled={busy} onClick={() => void resend()}>
          {t('auth.verify.resend')}
        </Button>
      </div>
    </AuthLayout>
  );
}
