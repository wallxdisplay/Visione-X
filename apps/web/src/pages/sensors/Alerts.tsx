import { Alert, Button, EmptyState, PageHeader, StatusChip } from '@wallx-play/ui';
import { formatLiveValue } from '@wallx-play/layout-spec';
import type { AlertDoc } from '@wallx-play/shared';
import { BellOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useOpenAlerts, useRecentAlerts } from '../../content/sensors';
import { call, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { WithId } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';
import './sensors.css';

/** One-line description of an alert, rendered from its fields (i18n). */
export function alertText(a: AlertDoc, t: (k: string, o?: Record<string, unknown>) => string): string {
  const v = (n: number | null) => (n === null ? '—' : `${formatLiveValue(n)}${a.unit ? ` ${a.unit}` : ''}`);
  if (a.type === 'offline') return t('alerts.text.offline');
  if (a.type === 'stale') return t('alerts.text.stale', { channel: a.channelName ?? '' });
  return t('alerts.text.threshold', {
    rule: a.ruleLabel ?? '',
    channel: a.channelName ?? '',
    value: v(a.value),
    operator: a.operator ?? '',
    limit: v(a.limit),
  });
}

function AlertTable({ rows, history }: { rows: Array<WithId<AlertDoc>>; history: boolean }) {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function acknowledge(id: string) {
    setBusy(id);
    setError(null);
    try {
      await call('acknowledgeAlert', { orgId, alertId: id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="wxp-table-wrap">
        <table className="wxp-table">
          <thead>
            <tr>
              <th>{t('alerts.severityLabel')}</th>
              <th>{t('alerts.what')}</th>
              <th>{t('alerts.sensor')}</th>
              <th>{t('alerts.opened')}</th>
              <th>{history ? t('alerts.resolved') : t('alerts.latest')}</th>
              <th>{t('alerts.acknowledged')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  <StatusChip tone={a.status === 'resolved' ? 'neutral' : a.severity === 'critical' ? 'danger' : 'warning'}>
                    {a.status === 'resolved' ? t('alerts.status.resolved') : t(`alerts.severity.${a.severity}`)}
                  </StatusChip>
                </td>
                <td>{alertText(a, t)}</td>
                <td>
                  <Link to={`/sensors/${a.sensorDeviceId}`}>{a.sensorName}</Link>
                  {a.channelName ? <span className="wxp-muted"> · {a.channelName}</span> : null}
                </td>
                <td>{formatDateTime(a.openedAt)}</td>
                <td className="wxp-tabular">
                  {history
                    ? formatDateTime(a.resolvedAt)
                    : a.lastValue !== null
                      ? `${formatLiveValue(a.lastValue)}${a.unit ? ` ${a.unit}` : ''}`
                      : '—'}
                </td>
                <td>
                  {a.acknowledgedAt ? (
                    <span className="wxp-muted">{t('alerts.ackBy', { who: a.acknowledgedByEmail ?? a.acknowledgedBy, when: formatDateTime(a.acknowledgedAt) })}</span>
                  ) : can('sensor.manage') && a.status === 'open' ? (
                    <Button size="sm" disabled={busy === a.id} onClick={() => void acknowledge(a.id)}>
                      {t('alerts.acknowledge')}
                    </Button>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Sensor alerts: open ones first, then recent history. */
export function Alerts() {
  const { t } = useTranslation();
  const { orgId, can, entitlements } = useOrg();
  const enabled = !!entitlements?.features.includes('sensor.esp32') && can('sensor.view');
  const open = useOpenAlerts(orgId, enabled);
  const recent = useRecentAlerts(orgId, enabled);
  const resolved = recent.data.filter((a) => a.status === 'resolved');

  return (
    <>
      <PageHeader title={t('nav.alerts')} description={t('alerts.description')} />
      {!enabled && entitlements ? (
        <div className="wxp-card">
          <EmptyState icon={<BellOff size={24} aria-hidden />} title={t('sensors.notInPlanTitle')} description={t('sensors.notInPlanBody')} />
        </div>
      ) : (
        <>
          <h2 className="section-title">{t('alerts.openTitle', { count: open.data.length })}</h2>
          {open.data.length === 0 && !open.loading ? (
            <div className="wxp-card">
              <EmptyState icon={<BellOff size={24} aria-hidden />} title={t('alerts.noneOpen')} description={t('alerts.noneOpenBody')} />
            </div>
          ) : (
            <AlertTable rows={open.data} history={false} />
          )}
          {resolved.length ? (
            <>
              <h2 className="section-title alerts-history">{t('alerts.historyTitle')}</h2>
              <AlertTable rows={resolved} history />
            </>
          ) : null}
        </>
      )}
    </>
  );
}
