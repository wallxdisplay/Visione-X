import { Alert, Button } from '@wallx-play/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { call, errorMessage } from '../lib/api';
import { AuthLayout } from './auth/AuthLayout';

export function AcceptInvite() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const { orgId } = await call<{ orgId: string }>('acceptInvite', { token });
      try {
        localStorage.setItem('wxp.currentOrg', orgId);
      } catch {
        /* ignore */
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t('invite.title')} description={t('invite.description', { email: user?.email })}>
      <div className="wxp-form">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button variant="primary" disabled={busy} onClick={() => void accept()}>
          {t('invite.accept')}
        </Button>
      </div>
    </AuthLayout>
  );
}
