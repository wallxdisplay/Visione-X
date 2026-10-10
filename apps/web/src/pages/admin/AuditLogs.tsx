import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { Alert, PageHeader, TextField } from '@visione-x/ui';
import { hasPlatformPermission, type AuditDoc } from '@visione-x/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { db } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';

export function AuditLogs() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const allowed = hasPlatformPermission(platformRole, 'audit.view');
  const [orgFilter, setOrgFilter] = useState('');
  const orgId = orgFilter.trim();

  const logs = useQueryData<AuditDoc>(allowed ? `audit:${orgId}` : null, () =>
    orgId
      ? query(collection(db, 'auditLogs'), where('orgId', '==', orgId), orderBy('at', 'desc'), limit(200))
      : query(collection(db, 'auditLogs'), orderBy('at', 'desc'), limit(200)),
  );

  if (!allowed) {
    return (
      <>
        <PageHeader title={t('nav.admin.audit')} />
        <Alert tone="info">{t('admin.audit.notAllowed')}</Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('nav.admin.audit')} description={t('admin.audit.description')} />
      <div style={{ maxWidth: 360, marginBottom: 16 }}>
        <TextField
          label={t('admin.audit.filterOrg')}
          placeholder={t('admin.audit.filterOrgPlaceholder')}
          value={orgFilter}
          onChange={(e) => setOrgFilter(e.target.value)}
        />
      </div>
      {logs.error ? <Alert tone="danger">{t('errors.generic')}</Alert> : null}
      <div className="vx-table-wrap">
        <table className="vx-table">
          <thead>
            <tr>
              <th>{t('admin.audit.when')}</th>
              <th>{t('admin.audit.action')}</th>
              <th>{t('admin.audit.actor')}</th>
              <th>{t('admin.audit.target')}</th>
              <th>{t('admin.audit.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {logs.data.map((l) => (
              <tr key={l._id}>
                <td className="vx-tabular">{formatDateTime(l.at)}</td>
                <td>
                  <code>{l.action}</code>
                  <div className="vx-muted">
                    {l.chainId} #{l.seq}
                  </div>
                </td>
                <td>
                  {l.actorEmail ?? l.actorId}
                  <div className="vx-muted">{t(`admin.audit.actorType.${l.actorType}`)}</div>
                </td>
                <td>
                  {l.target.type}
                  <div className="vx-muted">{l.target.id}</div>
                </td>
                <td>{l.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
