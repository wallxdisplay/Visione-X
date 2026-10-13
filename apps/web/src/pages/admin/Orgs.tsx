import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { Alert, Button, Dialog, PageHeader, StatusChip, TextAreaField } from '@wallx-play/ui';
import { hasPlatformPermission, type OrgDoc, type OrgStatus } from '@wallx-play/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDate } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';

const TONE: Record<OrgStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  active: 'success',
  pending: 'warning',
  info_requested: 'info',
  suspended: 'danger',
  rejected: 'neutral',
};
const FILTERS = ['all', 'active', 'pending', 'suspended', 'rejected'] as const;

export function Orgs() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const orgs = useQueryData<OrgDoc>(`orgs:${filter}`, () =>
    filter === 'all'
      ? query(collection(db, 'orgs'), orderBy('createdAt', 'desc'), limit(100))
      : query(collection(db, 'orgs'), where('status', '==', filter), orderBy('createdAt', 'desc'), limit(100)),
  );
  const [target, setTarget] = useState<{ org: OrgDoc; action: 'suspend' | 'reactivate' } | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSuspend = hasPlatformPermission(platformRole, 'org.suspend');

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await call('setOrgStatus', { orgId: target.org.id, action: target.action, reason });
      setTarget(null);
      setReason('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={t('nav.admin.orgs')} description={t('admin.orgs.description')} />
      <div className="wxp-toolbar">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            className={`wxp-btn wxp-btn--sm ${filter === f ? 'wxp-btn--primary' : 'wxp-btn--secondary'}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? t('common.all') : t(`status.${f}`)}
          </button>
        ))}
      </div>
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('admin.orgs.name')}</th>
              <th>{t('admin.approvals.status')}</th>
              <th>{t('settings.timezone')}</th>
              <th>{t('admin.orgs.created')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {orgs.data.map((o) => (
              <tr key={o.id}>
                <td>
                  {o.name}
                  <div className="wxp-muted">{o.id}</div>
                </td>
                <td>
                  <StatusChip tone={TONE[o.status]}>{t(`status.${o.status}`)}</StatusChip>
                  {o.statusReason && o.status === 'suspended' ? (
                    <div className="wxp-muted">{o.statusReason}</div>
                  ) : null}
                </td>
                <td>{o.timezone}</td>
                <td className="wxp-tabular">{formatDate(o.createdAt)}</td>
                <td className="wxp-actions">
                  {canSuspend && o.status === 'active' ? (
                    <Button size="sm" variant="tertiary" onClick={() => setTarget({ org: o, action: 'suspend' })}>
                      {t('admin.orgs.suspend')}
                    </Button>
                  ) : null}
                  {canSuspend && o.status === 'suspended' ? (
                    <Button size="sm" variant="tertiary" onClick={() => setTarget({ org: o, action: 'reactivate' })}>
                      {t('admin.orgs.reactivate')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={!!target}
        title={target ? t(`admin.orgs.${target.action}Title`, { org: target.org.name }) : ''}
        onClose={() => {
          setTarget(null);
          setError(null);
        }}
        footer={
          <>
            <Button onClick={() => setTarget(null)}>{t('common.cancel')}</Button>
            <Button
              variant={target?.action === 'suspend' ? 'danger' : 'primary'}
              disabled={busy || reason.trim().length < 5}
              onClick={() => void submit()}
            >
              {target ? t(`admin.orgs.${target.action}`) : ''}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>{target ? t(`admin.orgs.${target.action}Body`) : ''}</p>
        <TextAreaField
          label={t('admin.orgs.reason')}
          required
          hint={t('admin.orgs.reasonHint')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Dialog>
    </>
  );
}
