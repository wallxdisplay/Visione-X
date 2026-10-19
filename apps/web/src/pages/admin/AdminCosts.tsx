import { Alert, Button, Dialog, PageHeader, Spinner, StatusChip, TextField } from '@wallx-play/ui';
import { COST_DRIVERS, formatInr, hasPlatformPermission, type CostDriver, type CostRatesDoc, type CostReportResult } from '@wallx-play/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../auth/AuthProvider';
import { parseRupees, rupees } from '../../content/billing';
import { call, errorMessage } from '../../lib/api';
import '../billing/billing.css';
import './admin.css';

const RATE_KEYS = [
  'per1000Heartbeats',
  'perGbDelivered',
  'perGbMonthStored',
  'per1000WeatherCalls',
  'per1000AirQualityCalls',
  'per1000SensorRequests',
  'per1000ApiCalls',
  'per1000Emails',
  'perOrgMonth',
] as const satisfies ReadonlyArray<keyof CostRatesDoc>;

const thisMonth = () => new Date().toISOString().slice(0, 7);

function Margin({ revenue, cost }: { revenue: number; cost: number }) {
  if (revenue <= 0) return <span className="wxp-muted">—</span>;
  const m = 1 - cost / revenue;
  return <StatusChip tone={m >= 0.7 ? 'success' : m >= 0.4 ? 'warning' : 'danger'}>{`${Math.round(m * 100)}%`}</StatusChip>;
}

/** Super Admin → Profitability: what each organization and app earns against what it costs to run. */
export function AdminCosts() {
  const { t } = useTranslation();
  const { platformRole } = useAuth();
  const editRates = hasPlatformPermission(platformRole, 'plan.manage');
  const [month, setMonth] = useState(thisMonth());
  const [report, setReport] = useState<CostReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setReport(null);
    setError(null);
    call<CostReportResult>('costReport', { month }).then(setReport, (err) => setError(errorMessage(err)));
  }, [month, reload]);

  const totals = report
    ? report.rows.reduce((s, r) => ({ revenue: s.revenue + r.revenueMinor, cost: s.cost + r.costMinor, projected: s.projected + r.projectedCostMinor }), { revenue: 0, cost: 0, projected: 0 })
    : null;
  const biggest = (cost: Record<CostDriver, number>) => {
    const [driver, v] = (Object.entries(cost) as Array<[CostDriver, number]>).sort((a, b) => b[1] - a[1])[0] ?? ['fixed', 0];
    return v > 0 ? `${t(`adminCosts.drivers.${driver}`)} · ${formatInr(v)}` : '—';
  };

  return (
    <>
      <PageHeader
        title={t('nav.admin.costs')}
        description={t('adminCosts.description')}
        actions={
          <div className="wxp-toolbar" style={{ margin: 0 }}>
            <input className="wxp-input" type="month" aria-label={t('adminCosts.month')} value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            {editRates && report ? <Button onClick={() => setEditing(true)}>{t('adminCosts.editRates')}</Button> : null}
          </div>
        }
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!report && !error ? <Spinner label={t('common.loading')} /> : null}
      {report && totals ? (
        <>
          <div className="admin-billing__grid">
            <section className="wxp-card">
              <h2 className="wxp-card__title">{t('adminCosts.summary')}</h2>
              <dl className="wxp-dl">
                <dt>{t('adminCosts.revenue')}</dt>
                <dd className="wxp-tabular">{formatInr(totals.revenue)}</dd>
                <dt>{t('adminCosts.costSoFar', { days: report.daysCovered, total: report.daysInMonth })}</dt>
                <dd className="wxp-tabular">{formatInr(totals.cost)}</dd>
                <dt>{t('adminCosts.projected')}</dt>
                <dd className="wxp-tabular">{formatInr(totals.projected)}</dd>
                <dt>{t('adminCosts.margin')}</dt>
                <dd>
                  <Margin revenue={totals.revenue} cost={totals.projected} />
                </dd>
              </dl>
              <p className="wxp-muted">{t('adminCosts.summaryNote')}</p>
            </section>
            <section className="wxp-card">
              <h2 className="wxp-card__title">{t('adminCosts.byApp')}</h2>
              <div className="wxp-table-wrap">
                <table className="wxp-table">
                  <thead>
                    <tr>
                      <th>{t('adminCosts.app')}</th>
                      <th>{t('adminCosts.revenue')}</th>
                      <th>{t('adminCosts.cost')}</th>
                      <th>{t('adminCosts.margin')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byApp.map((a) => (
                      <tr key={a.appId}>
                        <td>{a.name}</td>
                        <td className="wxp-tabular">{formatInr(a.revenueMinor)}</td>
                        <td className="wxp-tabular">{formatInr(a.costMinor)}</td>
                        <td>
                          <Margin revenue={a.revenueMinor} cost={report.daysCovered ? (a.costMinor * report.daysInMonth) / report.daysCovered : a.costMinor} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <h2 className="section-title">{t('adminCosts.byOrg')}</h2>
          {report.rows.length === 0 ? (
            <p className="wxp-muted">{t('adminCosts.none')}</p>
          ) : (
            <div className="wxp-table-wrap">
              <table className="wxp-table">
                <thead>
                  <tr>
                    <th>{t('adminCosts.org')}</th>
                    <th>{t('adminCosts.revenue')}</th>
                    <th>{t('adminCosts.cost')}</th>
                    <th>{t('adminCosts.projected')}</th>
                    <th>{t('adminCosts.margin')}</th>
                    <th>{t('adminCosts.biggest')}</th>
                    <th>{t('adminCosts.usage')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.orgId}>
                      <td>
                        {r.name}
                        <div className="wxp-muted">
                          {t(`appBilling.modes.${r.pricing}`)}
                          {r.viaReseller ? ` · ${t('adminCosts.viaReseller')}` : ''}
                          {r.revenueMinor === 0 ? ` · ${t(`billing.status.${r.status}`, { defaultValue: r.status })}` : ''}
                        </div>
                      </td>
                      <td className="wxp-tabular">{formatInr(r.revenueMinor)}</td>
                      <td className="wxp-tabular">{formatInr(r.costMinor)}</td>
                      <td className="wxp-tabular">{formatInr(r.projectedCostMinor)}</td>
                      <td>
                        <Margin revenue={r.revenueMinor} cost={r.projectedCostMinor} />
                      </td>
                      <td>{biggest(r.cost)}</td>
                      <td className="wxp-muted">
                        {t('adminCosts.usageLine', {
                          screens: Math.round(r.usage.screens * 10) / 10,
                          gb: (r.usage.storageBytes / 1e9).toFixed(1),
                          weather: r.usage.weatherCalls + r.usage.airQualityCalls,
                          sensors: r.usage.sensorReadings,
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="wxp-muted">{t('adminCosts.note')}</p>
        </>
      ) : null}
      {editing && report ? (
        <RatesDialog
          rates={report.rates}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
    </>
  );
}

function RatesDialog({ rates, onClose, onSaved }: { rates: CostRatesDoc; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(RATE_KEYS.map((k) => [k, rupees(rates[k])])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = Object.fromEntries(RATE_KEYS.map((k) => [k, parseRupees(form[k] ?? '')]));
  const valid = RATE_KEYS.every((k) => parsed[k] !== null && parsed[k]! >= 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await call('saveCostRates', parsed);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t('adminCosts.ratesTitle')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !valid} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <p className="wxp-muted">{t('adminCosts.ratesHint')}</p>
      {RATE_KEYS.map((k) => (
        <TextField key={k} label={t(`adminCosts.rates.${k}`)} inputMode="decimal" value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
      ))}
      <p className="wxp-field__hint">{t('adminCosts.driversList', { list: COST_DRIVERS.map((d) => t(`adminCosts.drivers.${d}`)).join(', ') })}</p>
    </Dialog>
  );
}
