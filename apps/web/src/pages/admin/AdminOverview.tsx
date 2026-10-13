import { collection, getCountFromServer, query, where } from 'firebase/firestore';
import { Card, PageHeader } from '@wallx-play/ui';
import { paths } from '@wallx-play/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { db } from '../../lib/firebase';

interface Counts {
  pending: number;
  active: number;
  suspended: number;
}

export function AdminOverview() {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    const orgs = collection(db, 'orgs');
    Promise.all([
      getCountFromServer(
        query(collection(db, paths.signupRequests()), where('status', 'in', ['pending', 'info_requested'])),
      ),
      getCountFromServer(query(orgs, where('status', '==', 'active'))),
      getCountFromServer(query(orgs, where('status', '==', 'suspended'))),
    ])
      .then(([p, a, s]) => setCounts({ pending: p.data().count, active: a.data().count, suspended: s.data().count }))
      .catch(() => setCounts(null));
  }, []);

  const stat = (label: string, value: number | undefined, to?: string) => (
    <div className="wxp-stat">
      <div className="wxp-stat__label">{to ? <Link to={to}>{label}</Link> : label}</div>
      <div className="wxp-stat__value">{value ?? '—'}</div>
    </div>
  );

  return (
    <>
      <PageHeader title={t('nav.admin.overview')} description={t('admin.overview.description')} />
      <div className="wxp-stat-row">
        {stat(t('admin.overview.pending'), counts?.pending, '/admin/approvals')}
        {stat(t('admin.overview.active'), counts?.active, '/admin/orgs')}
        {stat(t('admin.overview.suspended'), counts?.suspended, '/admin/orgs')}
      </div>
      <Card title={t('admin.overview.comingTitle')}>
        <p className="wxp-muted" style={{ margin: 0 }}>
          {t('admin.overview.comingBody')}
        </p>
      </Card>
    </>
  );
}
