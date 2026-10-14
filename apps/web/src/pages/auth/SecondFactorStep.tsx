import { TotpMultiFactorGenerator, type MultiFactorResolver } from 'firebase/auth';
import { Alert, Button, SelectField, TextField } from '@wallx-play/ui';
import { useState, type FormEvent, type InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../lib/api';
import { AuthLayout } from './AuthLayout';

export const CODE_LENGTH = 6;

/** The 6-digit code from an authenticator app (digits only, so pasted spaces are dropped). */
export function CodeField({
  value,
  onChange,
  hint,
  ...input
}: { value: string; onChange: (code: string) => void; hint?: string } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
>) {
  const { t } = useTranslation();
  return (
    <TextField
      label={t('auth.mfa.code')}
      hint={hint}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={CODE_LENGTH}
      required
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
      {...input}
    />
  );
}

/** Second sign-in step for accounts with two-step verification (Firebase multi-factor sign-in). */
export function SecondFactorStep({ resolver, onCancel }: { resolver: MultiFactorResolver; onCancel: () => void }) {
  const { t } = useTranslation();
  const hints = resolver.hints.filter((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  const [hintId, setHintId] = useState(hints[0]?.uid ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // RedirectIfSignedIn navigates once auth state updates.
      await resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hintId, code));
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t('auth.mfa.signIn.title')}
      description={t('auth.mfa.signIn.description')}
      footer={
        <button type="button" className="auth__link-btn" onClick={onCancel}>
          {t('auth.backToSignIn')}
        </button>
      }
    >
      <form className="wxp-form" onSubmit={onSubmit} noValidate>
        {!hints.length ? <Alert tone="danger">{t('auth.mfa.signIn.unsupported')}</Alert> : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {hints.length > 1 ? (
          <SelectField
            label={t('auth.mfa.signIn.which')}
            value={hintId}
            onChange={(e) => setHintId(e.target.value)}
            options={hints.map((h) => ({ value: h.uid, label: h.displayName || t('auth.mfa.defaultName') }))}
          />
        ) : null}
        <CodeField value={code} onChange={setCode} autoFocus disabled={!hints.length} />
        <Button type="submit" variant="primary" disabled={busy || !hintId || code.length !== CODE_LENGTH}>
          {t('auth.mfa.signIn.action')}
        </Button>
      </form>
    </AuthLayout>
  );
}
