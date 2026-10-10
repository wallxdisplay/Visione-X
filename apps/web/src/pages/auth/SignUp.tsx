import { createUserWithEmailAndPassword, sendEmailVerification } from 'firebase/auth';
import { Alert, Button, TextField } from '@visione-x/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { errorMessage } from '../../lib/api';
import { auth } from '../../lib/firebase';
import { AuthLayout } from './AuthLayout';

const MIN_PASSWORD = 10;

export function SignUp() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qs = params.toString() ? `?${params.toString()}` : '';

  const passwordError =
    password && password.length < MIN_PASSWORD ? t('auth.signUp.passwordTooShort', { min: MIN_PASSWORD }) : undefined;
  const confirmError = confirm && confirm !== password ? t('auth.signUp.passwordMismatch') : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (passwordError || confirmError) return;
    setBusy(true);
    setError(null);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      // RedirectIfSignedIn moves the new (unverified) user to /verify-email.
      await sendEmailVerification(cred.user, { url: `${window.location.origin}/verify-email${qs}` });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t('auth.signUp.title')}
      description={t('auth.signUp.description')}
      footer={
        <>
          {t('auth.signUp.haveAccount')} <Link to={`/signin${qs}`}>{t('auth.signIn.action')}</Link>
        </>
      }
    >
      <form className="vx-form" onSubmit={onSubmit} noValidate>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField
          label={t('auth.workEmail')}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label={t('auth.password')}
          type="password"
          autoComplete="new-password"
          required
          hint={t('auth.signUp.passwordHint', { min: MIN_PASSWORD })}
          error={passwordError}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <TextField
          label={t('auth.signUp.confirm')}
          type="password"
          autoComplete="new-password"
          required
          error={confirmError}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !email || !password || !confirm || !!passwordError || !!confirmError}
        >
          {t('auth.signUp.action')}
        </Button>
      </form>
    </AuthLayout>
  );
}
