import { collection, limit, query } from 'firebase/firestore';
import { Alert, Button, PageHeader, StatusChip } from '@visione-x/ui';
import { BILLING_STATUSES, formatInr, hasPlatformPermission, isLegacySubscription, type BillingStatus, type OrgDoc } from '@visione-x/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { call, errorMessage } from '../../lib/api';
import { orgIdOf, useAllSubscriptions, useOpenBillingRequests, usePlans } from '../../content/billing';
import { db } from '../../lib/firebase';
import { formatDate } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { STATUS_TONE } from '../billing/Billing';
import '../billing/billing.css';

/** Billing staff: every organization's subscription, overdue first, plus open customer requests. */
export function AdminBilling() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<BillingStatus | 'all'>('all');
  const subs = useAllSubscriptions(true);
  const requests = useOpenBillingRequests(true);
  const plans = usePlans(true);
  const orgs = useQueryData<OrgDoc>('orgs:billing', () => query(collection(db, 'orgs'), limit(1000)));
  const orgName = useMemo(() => new Map(orgs.data.map((o) => [o.id, o.name])), [orgs.data]);
  const planName = (id: string) => plans.data.find((p) => p.id === id)?.name ?? id;
  const { platformRole } = useAuth();
  const legacy = subs.data.filter((s) => s._id === 'subscription' && isLegacySubscription(s)).length;
  const [migrating, setMigrating] = useState(false);
  const [migration, setMigration] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  async function migrate() {
    setMigrating(true);
    try {
      const r = await call<{ migrated: number }>('migrateSubscriptions', {});
      setMigration({ tone: 'success', text: t('adminBilling.migrated', { count: r.migrated }) });
    } catch (err) {
      setMigration({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setMigrating(false);
    }
  }

  // Attention first: restricted, past due, trial ending soonest, then the rest by renewal date.
  const order: Record<BillingStatus, number> = { restricted: 0, past_due: 1, trialing: 2, active: 3, cancelled: 4 };
  const rows = subs.data
    .filter((s) => s._id === 'subscription' && (filter === 'all' || s.status === filter))
    .sort((a, b) => order[a.status] - order[b.status] || (a.trialEndsAt ?? a.currentPeriodEnd ?? 0) - (b.trialEndsAt ?? b.currentPeriodEnd ?? 0));
  const counts = Object.fromEntries(BILLING_STATUSES.map((st) => [st, subs.data.filter((s) => s._id === 'subscription' && s.status === st).length]));

  return (
    <>
      <PageHeader title={t('nav.admin.billing')} description={t('adminBilling.description')} />
      {migration ? <Alert tone={migration.tone}>{migration.text}</Alert> : null}
      {legacy > 0 && hasPlatformPermission(platformRole, 'settings.edit') ? (
        <Alert tone="warning">
          {t('adminBilling.legacy', { count: legacy })}{' '}
          <Button size="sm" disabled={migrating} onClick={() => void migrate()}>
            {t('adminBilling.migrate')}
          </Button>
        </Alert>
      ) : null}

      {requests.data.length ? (
        <>
          <h2 className="section-title">{t('adminBilling.openRequests', { count: requests.data.length })}</h2>
          <div className="vx-table-wrap">
            <table className="vx-table">
              <thead>
                <tr>
                  <th>{t('adminBilling.org')}</th>
                  <th>{t('adminBilling.request')}</th>
                  <th>{t('billing.message')}</th>
                  <th>{t('adminBilling.received')}</th>
                </tr>
              </thead>
              <tbody>
                {[...requests.data]
                  .sort((a, b) => a.createdAt - b.createdAt)
                  .map((r) => (
                    <tr key={r._path}>
                      <td>
                        <Link to={`/admin/billing/${r.orgId}`}>{r.orgName}</Link>
                      </td>
                      <td>
                        {t(`billing.kinds.${r.kind}`)}
                        {r.quantity ? ` · ${t('billing.screensN', { count: r.quantity })}` : ''}
                        {r.planId ? ` · ${planName(r.planId)}` : ''}
                        {r.interval ? ` · ${t(`billing.intervals.${r.interval}`)}` : ''}
                      </td>
                      <td className="vx-muted">{r.message || '—'}</td>
                      <td>{formatDate(r.createdAt)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2 className="section-title">{t('adminBilling.subscriptions')}</h2>
      <div className="admin-billing__filters" role="group" aria-label={t('adminBilling.filter')}>
        {(['all', ...BILLING_STATUSES] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            className={`vx-btn vx-btn--sm ${filter === f ? 'vx-btn--primary' : 'vx-btn--secondary'}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? t('common.all') : `${t(`billing.status.${f}`)} (${counts[f]})`}
          </button>
        ))}
      </div>
      <div className="vx-table-wrap">
        <table className="vx-table">
          <thead>
            <tr>
              <th>{t('adminBilling.org')}</th>
              <th>{t('billing.plan')}</th>
              <th>{t('adminBilling.statusCol')}</th>
              <th>{t('billing.screens')}</th>
              <th>{t('adminBilling.dueDate')}</th>
              <th>{t('billing.price')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const id = orgIdOf(s._path);
              return (
                <tr key={s._path}>
                  <td>
                    <Link to={`/admin/billing/${id}`}>{orgName.get(id) ?? id}</Link>
                  </td>
                  <td>
                    {planName(s.planId)} <span className="vx-muted">· {t(`billing.intervals.${s.interval}`)}</span>
                  </td>
                  <td>
                    <StatusChip tone={STATUS_TONE[s.status]}>{t(`billing.status.${s.status}`)}</StatusChip>
                  </td>
                  <td className="vx-tabular">{s.quantity}</td>
                  <td>{formatDate(s.status === 'trialing' ? s.trialEndsAt : s.currentPeriodEnd)}</td>
                  <td className="vx-tabular">{s.amountPerPeriodMinor !== null ? formatInr(s.amountPerPeriodMinor) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
