import { Alert, Card, PageHeader, Spinner, StatusChip } from '@wallx-play/ui';
import type { ApiOverviewRow } from '@wallx-play/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import '../reports/reports.css';

/** Super Admin: who uses the public API and webhooks (counts only, no customer keys or addresses). */
export function AdminApi() {
  const { t } = useTranslation();
  const [data, setData] = useState<{ day: string; orgs: ApiOverviewRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const num = useMemo(() => new Intl.NumberFormat(currentLocale()), []);

  useEffect(() => {
    call<{ day: string; orgs: ApiOverviewRow[] }>('apiOverview', {})
      .then(setData)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const totals = data?.orgs.reduce((a, o) => ({ keys: a.keys + o.activeKeys, calls: a.calls + o.callsToday, off: a.off + o.webhooksOff }), { keys: 0, calls: 0, off: 0 });

  return (
    <>
      <PageHeader title={t('nav.admin.integrations')} description={t('api.admin.description')} />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!data && !error ? <Spinner label={t('common.loading')} /> : null}
      {data && totals ? (
        <div className="reports__body">
          <div className="reports__totals">
            <div className="wxp-card reports__stat">
              <span className="wxp-muted">{t('api.admin.orgs')}</span>
              <strong>{num.format(data.orgs.length)}</strong>
            </div>
            <div className="wxp-card reports__stat">
              <span className="wxp-muted">{t('api.admin.activeKeys')}</span>
              <strong>{num.format(totals.keys)}</strong>
            </div>
            <div className="wxp-card reports__stat">
              <span className="wxp-muted">{t('api.admin.callsToday')}</span>
              <strong>{num.format(totals.calls)}</strong>
            </div>
            <div className="wxp-card reports__stat">
              <span className="wxp-muted">{t('api.admin.webhooksOff')}</span>
              <strong>{num.format(totals.off)}</strong>
            </div>
          </div>
          <Card title={t('api.admin.byOrg')}>
            {data.orgs.length === 0 ? (
              <p className="wxp-muted">{t('api.admin.none')}</p>
            ) : (
              <div className="wxp-table-wrap">
                <table className="wxp-table">
                  <thead>
                    <tr>
                      <th>{t('api.admin.org')}</th>
                      <th>{t('api.admin.plan')}</th>
                      <th className="reports__num">{t('api.admin.activeKeys')}</th>
                      <th className="reports__num">{t('api.admin.callsToday')}</th>
                      <th className="reports__num">{t('api.admin.webhooks')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orgs.map((o) => (
                      <tr key={o.orgId}>
                        <td>{o.name}</td>
                        <td>
                          {o.apiInPlan || o.webhooksInPlan ? (
                            <StatusChip tone="success">{t('api.admin.inPlan')}</StatusChip>
                          ) : (
                            <StatusChip tone="warning">{t('api.admin.notInPlan')}</StatusChip>
                          )}
                        </td>
                        <td className="reports__num">{num.format(o.activeKeys)}</td>
                        <td className="reports__num">
                          {num.format(o.callsToday)}
                          {o.limitPerDay !== null ? <span className="wxp-muted"> / {num.format(o.limitPerDay)}</span> : null}
                        </td>
                        <td className="reports__num">
                          {num.format(o.webhooks)}
                          {o.webhooksOff ? <span className="wxp-field__error"> ({t('api.admin.off', { count: o.webhooksOff })})</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="wxp-muted reports__note">{t('api.admin.note', { day: data.day })}</p>
        </div>
      ) : null}
    </>
  );
}
