import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { Alert, Button, Card, StatusChip, Spinner, TextAreaField } from '@visione-x/ui';
import { paths, type OrgSignupDetails, type SignupRequestDoc } from '@visione-x/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { pickActiveOrg } from '../../org/OrgProvider';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { OrgSignupForm, toFormValues } from './OrgSignupForm';

export function Onboarding() {
  const { t } = useTranslation();
  const { user, profile, platformRole, signOut } = useAuth();
  const uid = user!.uid;
  const requests = useQueryData<SignupRequestDoc>(`signup:${uid}`, () =>
    query(
      collection(db, paths.signupRequests()),
      where('requestedBy', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(1),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startNew, setStartNew] = useState(false);
  const [response, setResponse] = useState('');

  const hasActiveOrg = !!pickActiveOrg(profile?.memberships);
  const latest = requests.data[0];

  async function submit(details: OrgSignupDetails) {
    setBusy(true);
    setError(null);
    try {
      await call('submitOrgSignup', details);
      setStartNew(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resubmit(details: OrgSignupDetails) {
    if (!latest) return;
    if (!response.trim()) {
      setError(t('onboarding.responseRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await call('resubmitOrgSignup', { requestId: latest.id, details, response });
      setResponse('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (requests.loading) {
    body = <Spinner label={t('common.loading')} />;
  } else if (latest && !startNew && latest.status === 'pending') {
    body = (
      <div className="vx-stack">
        <div>
          <StatusChip tone="warning">{t('status.pending')}</StatusChip>
        </div>
        <p>{t('onboarding.pendingBody', { org: latest.details.orgName })}</p>
        <p className="vx-muted">{t('onboarding.submittedAt', { at: formatDateTime(latest.createdAt) })}</p>
      </div>
    );
  } else if (latest && !startNew && latest.status === 'info_requested') {
    body = (
      <div className="vx-stack">
        <Alert tone="warning" title={t('onboarding.infoRequestedTitle')}>
          {latest.messages.filter((m) => m.from === 'admin').at(-1)?.text}
        </Alert>
        <OrgSignupForm
          initial={toFormValues(latest.details)}
          submitLabel={t('onboarding.resubmit')}
          busy={busy}
          onSubmit={(d) => void resubmit(d)}
        >
          <TextAreaField
            label={t('onboarding.response')}
            required
            value={response}
            onChange={(e) => setResponse(e.target.value)}
          />
        </OrgSignupForm>
      </div>
    );
  } else if (latest && !startNew && latest.status === 'rejected') {
    body = (
      <div className="vx-stack">
        <Alert tone="danger" title={t('onboarding.rejectedTitle')}>
          {latest.messages.filter((m) => m.from === 'admin').at(-1)?.text}
        </Alert>
        <div>
          <Button onClick={() => setStartNew(true)}>{t('onboarding.newRequest')}</Button>
        </div>
      </div>
    );
  } else if (latest && !startNew && latest.status === 'approved' && !hasActiveOrg) {
    // Approved but profile not yet refreshed (or org since suspended).
    body = <Alert tone="info">{t('onboarding.approvedNoAccess')}</Alert>;
  } else {
    body = (
      <OrgSignupForm submitLabel={t('onboarding.submit')} busy={busy} onSubmit={(d) => void submit(d)} />
    );
  }

  return (
    <div className="onboarding">
      <header className="onboarding__header">
        <div className="auth__brand">
          <span className="shell__logo" aria-hidden>
            X
          </span>
          <strong>{t('product.name')}</strong>
        </div>
        <div className="onboarding__user">
          {platformRole ? (
            <Link to="/admin" className="vx-btn vx-btn--tertiary vx-btn--sm">
              {t('shell.adminBadge')}
            </Link>
          ) : null}
          <span className="vx-muted">{user?.email}</span>
          <Button size="sm" variant="tertiary" onClick={() => void signOut()}>
            {t('shell.signOut')}
          </Button>
        </div>
      </header>
      <main className="onboarding__main">
        <h1>{t('onboarding.title')}</h1>
        <p className="auth__desc">{t('onboarding.description')}</p>
        {hasActiveOrg ? (
          <Alert tone="success">
            {t('onboarding.hasActiveOrg')} <Link to="/">{t('onboarding.goToDashboard')}</Link>
          </Alert>
        ) : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Card>{body}</Card>
        <p className="vx-muted">{t('onboarding.inviteHint')}</p>
      </main>
    </div>
  );
}
