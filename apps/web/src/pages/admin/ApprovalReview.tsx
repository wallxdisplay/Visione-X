import { Alert, Button, Card, Dialog, PageHeader, Spinner, StatusChip, TextAreaField } from '@visione-x/ui';
import { hasPlatformPermission, paths, stateName, type SignupRequestDoc } from '@visione-x/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useDoc } from '../../lib/hooks';
import { REQUEST_TONE } from './Approvals';

type Decision = 'approve' | 'reject' | 'request_info';

export function ApprovalReview() {
  const { t } = useTranslation();
  const { requestId = '' } = useParams();
  const { platformRole } = useAuth();
  const request = useDoc<SignupRequestDoc>(paths.signupRequest(requestId));
  const [decision, setDecision] = useState<Decision | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (request.loading) return <Spinner label={t('common.loading')} />;
  const r = request.data;
  if (!r) return <Alert tone="danger">{t('admin.approvals.notFound')}</Alert>;

  const canDecide = hasPlatformPermission(platformRole, 'org.approve');
  const open = r.status === 'pending' || r.status === 'info_requested';
  const needsMessage = decision === 'reject' || decision === 'request_info';

  async function submit() {
    if (!decision) return;
    setBusy(true);
    setError(null);
    try {
      await call('reviewOrgSignup', { requestId, decision, ...(message.trim() ? { message } : {}) });
      setDecision(null);
      setMessage('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const d = r.details;
  return (
    <>
      <p>
        <Link to="/admin/approvals">← {t('nav.admin.approvals')}</Link>
      </p>
      <PageHeader
        title={d.orgName}
        description={<StatusChip tone={REQUEST_TONE[r.status]}>{t(`status.${r.status}`)}</StatusChip>}
        actions={
          canDecide && open ? (
            <div className="vx-toolbar" style={{ margin: 0 }}>
              {r.status === 'pending' ? (
                <Button onClick={() => setDecision('request_info')}>{t('admin.approvals.requestInfo')}</Button>
              ) : null}
              <Button variant="danger" onClick={() => setDecision('reject')}>
                {t('admin.approvals.reject')}
              </Button>
              <Button variant="primary" onClick={() => setDecision('approve')}>
                {t('admin.approvals.approve')}
              </Button>
            </div>
          ) : null
        }
      />
      <div className="vx-stack">
        <Card title={t('admin.approvals.details')}>
          <dl className="vx-dl">
            <dt>{t('onboarding.contactName')}</dt>
            <dd>{d.contactName}</dd>
            <dt>{t('auth.email')}</dt>
            <dd>{r.requesterEmail}</dd>
            <dt>{t('onboarding.phone')}</dt>
            <dd>{d.phone}</dd>
            <dt>{t('admin.approvals.location')}</dt>
            <dd>
              {d.city}, {stateName(d.stateCode)}
            </dd>
            <dt>{t('onboarding.expectedScreens')}</dt>
            <dd className="vx-tabular">{d.expectedScreens}</dd>
            <dt>{t('onboarding.gstin')}</dt>
            <dd>{d.gstin ?? '—'}</dd>
            <dt>{t('onboarding.timezone')}</dt>
            <dd>{d.timezone}</dd>
            <dt>{t('onboarding.notes')}</dt>
            <dd>{d.notes || '—'}</dd>
            <dt>{t('admin.approvals.submitted')}</dt>
            <dd>{formatDateTime(r.createdAt)}</dd>
          </dl>
        </Card>
        {r.messages.length > 0 ? (
          <Card title={t('admin.approvals.conversation')}>
            <ul className="thread">
              {r.messages.map((m) => (
                <li key={m.at} className={`thread__msg thread__msg--${m.from}`}>
                  <div className="vx-muted">
                    {t(`admin.approvals.from.${m.from}`)} · {formatDateTime(m.at)}
                  </div>
                  <div>{m.text}</div>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>

      <Dialog
        open={!!decision}
        title={decision ? t(`admin.approvals.confirm.${decision}`) : ''}
        onClose={() => {
          setDecision(null);
          setError(null);
        }}
        footer={
          <>
            <Button onClick={() => setDecision(null)}>{t('common.cancel')}</Button>
            <Button
              variant={decision === 'reject' ? 'danger' : 'primary'}
              disabled={busy || (needsMessage && message.trim().length < 5)}
              onClick={() => void submit()}
            >
              {decision ? t(`admin.approvals.confirmAction.${decision}`) : ''}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>{decision ? t(`admin.approvals.confirmBody.${decision}`, { org: d.orgName }) : ''}</p>
        <TextAreaField
          label={needsMessage ? t('admin.approvals.messageRequired') : t('admin.approvals.messageOptional')}
          required={needsMessage}
          hint={t('admin.approvals.messageHint')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </Dialog>
    </>
  );
}
