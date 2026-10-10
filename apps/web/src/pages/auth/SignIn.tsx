import { GoogleAuthProvider, signInWithEmailAndPassword, signInWithPopup } from 'firebase/auth';
import { Alert, Button, TextField } from '@visione-x/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { errorMessage } from '../../lib/api';
import { auth } from '../../lib/firebase';
import { AuthLayout } from './AuthLayout';

export function SignIn() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qs = params.toString() ? `?${params.toString()}` : '';

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action(); // RedirectIfSignedIn navigates once auth state updates.
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(() => signInWithEmailAndPassword(auth, email.trim(), password));
  }

  return (
    <AuthLayout
      title={t('auth.signIn.title')}
      description={t('product.tagline')}
      footer={
        <>
          {t('auth.signIn.noAccount')} <Link to={`/signup${qs}`}>{t('auth.signUp.action')}</Link>
        </>
      }
    >
      <form className="vx-form" onSubmit={onSubmit} noValidate>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="auth__row">
          <Link to="/forgot-password">{t('auth.forgot.link')}</Link>
        </div>
        <Button type="submit" variant="primary" disabled={busy || !email || !password}>
          {t('auth.signIn.action')}
        </Button>
        <div className="auth__divider">
          <span>{t('auth.or')}</span>
        </div>
        <Button disabled={busy} onClick={() => void run(() => signInWithPopup(auth, new GoogleAuthProvider()))}>
          {t('auth.google')}
        </Button>
      </form>
    </AuthLayout>
  );
}
