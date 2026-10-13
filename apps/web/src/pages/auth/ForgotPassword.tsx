import { sendPasswordResetEmail } from 'firebase/auth';
import { Alert, Button, TextField } from '@wallx-play/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { auth } from '../../lib/firebase';
import { AuthLayout } from './AuthLayout';

export function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    // Same message whether or not the account exists, so emails cannot be enumerated.
    await sendPasswordResetEmail(auth, email.trim()).catch(() => undefined);
    setSent(true);
    setBusy(false);
  }

  return (
    <AuthLayout
      title={t('auth.forgot.title')}
      description={t('auth.forgot.description')}
      footer={<Link to="/signin">{t('auth.backToSignIn')}</Link>}
    >
      {sent ? (
        <Alert tone="success">{t('auth.forgot.sent')}</Alert>
      ) : (
        <form className="wxp-form" onSubmit={onSubmit} noValidate>
          <TextField
            label={t('auth.email')}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={busy || !email}>
            {t('auth.forgot.action')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
