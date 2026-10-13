import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { EmptyState, PageHeader, StatusChip } from '@wallx-play/ui';
import { paths, stateName, type SignupRequestDoc } from '@wallx-play/shared';
import { ClipboardCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { db } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';

export const REQUEST_TONE = {
  pending: 'warning',
  info_requested: 'info',
  approved: 'success',
  rejected: 'danger',
} as const;

export function Approvals() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'open' | 'decided'>('open');
  const requests = useQueryData<SignupRequestDoc>(`approvals:${tab}`, () =>
    tab === 'open'
      ? query(
          collection(db, paths.signupRequests()),
          where('status', 'in', ['pending', 'info_requested']),
          orderBy('createdAt', 'asc'),
        )
      : query(
          collection(db, paths.signupRequests()),
          where('status', 'in', ['approved', 'rejected']),
          orderBy('createdAt', 'desc'),
          limit(50),
        ),
  );

  return (
    <>
      <PageHeader title={t('nav.admin.approvals')} description={t('admin.approvals.description')} />
      <div className="wxp-toolbar" role="tablist">
        {(['open', 'decided'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={`wxp-btn wxp-btn--sm ${tab === k ? 'wxp-btn--primary' : 'wxp-btn--secondary'}`}
            onClick={() => setTab(k)}
          >
            {t(`admin.approvals.tabs.${k}`)}
          </button>
        ))}
      </div>

      {requests.data.length === 0 && !requests.loading ? (
        <div className="wxp-card">
          <EmptyState icon={<ClipboardCheck size={24} aria-hidden />} title={t('admin.approvals.empty')} />
        </div>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('admin.approvals.company')}</th>
                <th>{t('admin.approvals.requester')}</th>
                <th>{t('admin.approvals.location')}</th>
                <th>{t('admin.approvals.screens')}</th>
                <th>{t('admin.approvals.submitted')}</th>
                <th>{t('admin.approvals.status')}</th>
              </tr>
            </thead>
            <tbody>
              {requests.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/admin/approvals/${r.id}`}>{r.details.orgName}</Link>
                  </td>
                  <td>
                    {r.details.contactName}
                    <div className="wxp-muted">{r.requesterEmail}</div>
                  </td>
                  <td>
                    {r.details.city}, {stateName(r.details.stateCode)}
                  </td>
                  <td className="wxp-tabular">{r.details.expectedScreens}</td>
                  <td className="wxp-tabular">{formatDateTime(r.createdAt)}</td>
                  <td>
                    <StatusChip tone={REQUEST_TONE[r.status]}>{t(`status.${r.status}`)}</StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
