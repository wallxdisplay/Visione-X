import { Alert, Button, Card, PageHeader, SelectField, Spinner, StatusChip, TextField } from '@wallx-play/ui';
import type { ScreenAnalytics, ScreenDoc } from '@wallx-play/shared';
import { BarChart3 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useScreens, useSites } from '../../content/data';
import { currentLocale } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';
import { periodRange, todayIn } from '../reports/PlaybackReports';
import { ScreenDiagnostics, percent } from './ScreenDiagnostics';
import '../reports/reports.css';
import './analytics.css';
import { FeatureLocked } from '../../content/apps';

type Period = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom';
const PERIODS: Period[] = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'custom'];

/** Below this share of running time a screen is flagged. */
const LOW_UPTIME = 0.9;

/** Screen uptime, online time, errors and offline alerts over a period (screen diagnostics). */
export function Analytics() {
  const { t } = useTranslation();
  const { orgId, org, entitlements, siteScope } = useOrg();
  const inPlan = !!entitlements?.features.includes('screen.diagnostics');
  const timeZone = org?.timezone ?? 'Asia/Kolkata';
  const today = todayIn(timeZone);
  const sites = useSites(orgId);
  const screens = useScreens(orgId, siteScope);
  const [period, setPeriod] = useState<Period>('last7');
  const [custom, setCustom] = useState(() => periodRange('last7', today));
  const [siteId, setSiteId] = useState('');
  const [data, setData] = useState<ScreenAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [diagnosing, setDiagnosing] = useState<ScreenDoc | null>(null);

  const range = period === 'custom' ? custom : periodRange(period, today);
  const visibleSites = sites.data.filter((s) => !siteScope.length || siteScope.includes(s.id));
  const siteName = useMemo(() => new Map(sites.data.map((s) => [s.id, s.name])), [sites.data]);
  const num = useMemo(() => new Intl.NumberFormat(currentLocale()), []);

  useEffect(() => {
    if (!inPlan || !range.from || !range.to || range.from > range.to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    call<ScreenAnalytics>('screenAnalytics', { orgId, from: range.from, to: range.to, siteId: siteId || null, screenId: null })
      .then((r) => !cancelled && setData(r))
      .catch((err) => {
        if (!cancelled) {
          setData(null);
          setError(errorMessage(err));
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [orgId, inPlan, range.from, range.to, siteId]);

  if (entitlements && !inPlan) {
    return (
      <>
        <PageHeader title={t('nav.analytics')} description={t('analytics.description')} />
        <div className="wxp-card">
          <FeatureLocked feature="screen.diagnostics" icon={<BarChart3 size={24} aria-hidden />} title={t('analytics.notInPlanTitle')} fallback={t('analytics.notInPlanBody')} />
        </div>
      </>
    );
  }

  const missing = data ? data.totals.screens - data.totals.screensWithData : 0;
  const screenDoc = (id: string) => screens.data.find((s) => s.id === id);

  return (
    <>
      <PageHeader title={t('nav.analytics')} description={t('analytics.description')} />

      <div className="reports__filters">
        <SelectField
          label={t('reports.period')}
          value={period}
          onChange={(e) => {
            const p = e.target.value as Period;
            if (p === 'custom') setCustom(range);
            setPeriod(p);
          }}
          options={PERIODS.map((p) => ({ value: p, label: t(`reports.periods.${p}`) }))}
        />
        {period === 'custom' ? (
          <>
            <TextField type="date" label={t('reports.from')} value={custom.from} max={today} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <TextField type="date" label={t('reports.to')} value={custom.to} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </>
        ) : null}
        <SelectField
          label={t('reports.site')}
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          options={[{ value: '', label: t(siteScope.length ? 'reports.mySites' : 'reports.allSites') }, ...visibleSites.map((s) => ({ value: s.id, label: s.name }))]}
        />
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {loading && !data ? <Spinner label={t('common.loading')} /> : null}

      {data ? (
        <div className={loading ? 'reports__body reports__body--loading' : 'reports__body'}>
          <div className="reports__totals">
            <Stat label={t('analytics.running')} value={percent(data.totals.onShare)} hint={t('analytics.runningHint')} />
            <Stat label={t('analytics.online')} value={percent(data.totals.onlineShare)} hint={t('analytics.onlineHint')} />
            <Stat label={t('analytics.offlineAlerts')} value={num.format(data.totals.offline)} />
            <Stat label={t('analytics.errors')} value={num.format(data.totals.errors)} />
          </div>
          {missing > 0 ? <Alert tone="info">{t('analytics.missing', { count: missing })}</Alert> : null}

          {data.totals.screensWithData > 0 ? (
            <Card title={t('analytics.daily')}>
              <ul className="analytics__days analytics__days--wide">
                {data.byDay.map((d) => (
                  <li key={d.date}>
                    <span>{new Intl.DateTimeFormat(currentLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(`${d.date}T12:00:00Z`))}</span>
                    <span className="analytics__meter" title={t('analytics.dayTip', { on: percent(d.onShare), online: percent(d.onlineShare) })} aria-hidden>
                      <span style={{ width: `${(d.onShare ?? 0) * 100}%` }} />
                      <span className="analytics__meter-online" style={{ width: `${(d.onlineShare ?? 0) * 100}%` }} />
                    </span>
                    <span className="wxp-tabular">{percent(d.onShare)}</span>
                    <span className="wxp-tabular wxp-muted">{percent(d.onlineShare)}</span>
                  </li>
                ))}
              </ul>
              <p className="wxp-muted analytics__legend">
                <span className="analytics__key" /> {t('analytics.running')} <span className="analytics__key analytics__key--online" /> {t('analytics.online')}
              </p>
            </Card>
          ) : null}

          <Card title={t('analytics.byScreen')}>
            {data.byScreen.length === 0 ? (
              <p className="wxp-muted">{t('analytics.noScreens')}</p>
            ) : (
              <div className="wxp-table-wrap">
                <table className="wxp-table">
                  <thead>
                    <tr>
                      <th>{t('reports.screen')}</th>
                      <th>{t('reports.site')}</th>
                      <th className="reports__num">{t('analytics.running')}</th>
                      <th className="reports__num">{t('analytics.online')}</th>
                      <th className="reports__num">{t('analytics.offlineAlerts')}</th>
                      <th className="reports__num">{t('analytics.errors')}</th>
                      <th>{t('analytics.player')}</th>
                      <th>{t('analytics.lastSeen')}</th>
                      <th aria-label={t('common.actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {data.byScreen.map((s) => {
                      const doc = screenDoc(s.screenId);
                      return (
                        <tr key={s.screenId}>
                          <td>{s.name}</td>
                          <td>{(s.siteId && siteName.get(s.siteId)) || '—'}</td>
                          <td className="reports__num">
                            {s.onShare !== null && s.onShare < LOW_UPTIME ? <StatusChip tone="warning">{percent(s.onShare)}</StatusChip> : percent(s.onShare)}
                          </td>
                          <td className="reports__num">{percent(s.onlineShare)}</td>
                          <td className="reports__num">{num.format(s.offline)}</td>
                          <td className="reports__num">{num.format(s.errors)}</td>
                          <td className="wxp-tabular">{s.appVersion ? `v${s.appVersion}` : '—'}</td>
                          <td className="wxp-tabular">{formatDateTime(s.lastSeen)}</td>
                          <td className="wxp-actions">
                            {doc ? (
                              <Button size="sm" variant="tertiary" onClick={() => setDiagnosing(doc)}>
                                {t('analytics.diagnostics')}
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <p className="wxp-muted reports__note">{t('analytics.note', { tz: data.timezone })}</p>
        </div>
      ) : null}

      {diagnosing ? <ScreenDiagnostics orgId={orgId} screen={screenDoc(diagnosing.id) ?? diagnosing} timezone={timeZone} onClose={() => setDiagnosing(null)} /> : null}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="wxp-card reports__stat" title={hint}>
      <span className="wxp-muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
