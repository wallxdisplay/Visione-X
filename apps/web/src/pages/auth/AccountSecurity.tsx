import { FirebaseError } from 'firebase/app';
import { multiFactor, TotpMultiFactorGenerator, type MultiFactorInfo, type TotpSecret } from 'firebase/auth';
import { Alert, Button, TextField } from '@wallx-play/ui';
import QRCode from 'qrcode';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { safeNext } from '../../auth/guards';
import { staffMfaRequired, TOTP_ISSUER } from '../../auth/mfa';
import { errorMessage } from '../../lib/api';
import { useEmulators } from '../../lib/firebase';
import { AuthLayout } from './AuthLayout';
import { CODE_LENGTH, CodeField } from './SecondFactorStep';

interface Setup {
  secret: TotpSecret;
  qr: string;
}

/** Two-step verification (authenticator app): mandatory for WallX staff, optional for customers. */
export function AccountSecurity() {
  const { t } = useTranslation();
  const { user, platformRole, secondFactor, refresh, signOut } = useAuth();
  const [params] = useSearchParams();
  const [, setVersion] = useState(0);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user) return null; // RequireUser sends signed-out visitors to sign in.
  const factors = multiFactor(user).enrolledFactors;
  const staff = staffMfaRequired && !!platformRole;
  // Enrolled, but this session started before: signing in again adds the code step.
  const staleSession = staff && factors.length > 0 && !secondFactor;
  const blocked = staff && !secondFactor;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      // Changing second factors needs a fresh sign-in; signing out returns here afterwards.
      if (err instanceof FirebaseError && err.code === 'auth/requires-recent-login') setNeedsSignIn(true);
      else setMessage({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const startSetup = () =>
    run(async () => {
      const secret = await TotpMultiFactorGenerator.generateSecret(await multiFactor(user).getSession());
      const qr = await QRCode.toDataURL(secret.generateQrCodeUrl(user.email ?? user.uid, TOTP_ISSUER), { margin: 1, width: 220 });
      setCode('');
      setName('');
      setSetup({ secret, qr });
    });

  const finishSetup = (e: FormEvent) => {
    e.preventDefault();
    if (!setup) return;
    void run(async () => {
      const assertion = TotpMultiFactorGenerator.assertionForEnrollment(setup.secret, code);
      await multiFactor(user).enroll(assertion, name.trim() || t('auth.mfa.defaultName'));
      setSetup(null);
      await refresh();
      setMessage({ tone: 'success', text: t('auth.mfa.enrolled') });
    });
  };

  const remove = (factor: MultiFactorInfo) =>
    run(async () => {
      setRemoving(null);
      await multiFactor(user).unenroll(factor);
      setVersion((v) => v + 1);
      await refresh();
      setMessage({ tone: 'success', text: t('auth.mfa.removed') });
    });

  return (
    <AuthLayout
      title={t('auth.mfa.title')}
      description={t('auth.mfa.description')}
      footer={
        <>
          {!blocked ? <Link to={safeNext(params.get('next'))}>{t('auth.mfa.continue')}</Link> : null}{' '}
          <button type="button" className="auth__link-btn" onClick={() => void signOut()}>
            {t('shell.signOut')}
          </button>
        </>
      }
    >
      <div className="wxp-form">
        {useEmulators ? <Alert tone="info">{t('auth.mfa.emulator')}</Alert> : null}
        {staff && !factors.length ? <Alert tone="warning" title={t('auth.mfa.staffRequiredTitle')}>{t('auth.mfa.staffRequired')}</Alert> : null}
        {staleSession || needsSignIn ? (
          <Alert tone="warning">
            {t(needsSignIn ? 'auth.mfa.recentLogin' : 'auth.mfa.signInAgain')}{' '}
            <button type="button" className="auth__link-btn" onClick={() => void signOut()}>
              {t('auth.mfa.signInAgainAction')}
            </button>
          </Alert>
        ) : null}
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}

        {factors.length ? (
          <ul className="mfa__factors">
            {factors.map((f) => (
              <li key={f.uid} className="mfa__factor">
                <span>
                  <strong>{f.displayName || t('auth.mfa.defaultName')}</strong>
                  <small className="wxp-muted">{t('auth.mfa.addedOn', { value: Date.parse(f.enrollmentTime) })}</small>
                </span>
                {removing === f.uid ? (
                  <span className="mfa__confirm">
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(f)}>
                      {t('auth.mfa.removeConfirm')}
                    </Button>
                    <Button size="sm" variant="tertiary" onClick={() => setRemoving(null)}>
                      {t('common.cancel')}
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="tertiary" disabled={busy} onClick={() => setRemoving(f.uid)}>
                    {t('auth.mfa.remove')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="wxp-muted">{t('auth.mfa.none')}</p>
        )}
        {removing && staff && factors.length === 1 ? <Alert tone="warning">{t('auth.mfa.removeLastStaff')}</Alert> : null}

        {setup ? (
          <form className="wxp-form" onSubmit={finishSetup} noValidate>
            <ol>
              <li>{t('auth.mfa.setup.scan')}</li>
              <li>{t('auth.mfa.setup.enterCode')}</li>
            </ol>
            <img className="mfa__qr" src={setup.qr} width={220} height={220} alt={t('auth.mfa.setup.qrAlt')} />
            <p className="wxp-muted">
              {t('auth.mfa.setup.manual')} <code className="mfa__secret">{setup.secret.secretKey}</code>
            </p>
            <CodeField value={code} onChange={setCode} autoFocus />
            <TextField
              label={t('auth.mfa.setup.name')}
              hint={t('auth.mfa.setup.nameHint')}
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy || code.length !== CODE_LENGTH}>
              {t('auth.mfa.setup.verify')}
            </Button>
            <Button variant="tertiary" disabled={busy} onClick={() => setSetup(null)}>
              {t('common.cancel')}
            </Button>
          </form>
        ) : (
          <Button variant={factors.length ? 'secondary' : 'primary'} disabled={busy || staleSession} onClick={() => void startSetup()}>
            {t(factors.length ? 'auth.mfa.addAnother' : 'auth.mfa.setUp')}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}
