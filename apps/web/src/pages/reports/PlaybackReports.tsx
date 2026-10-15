import { Alert, Button, Card, EmptyState, PageHeader, SelectField, Spinner, TextField } from '@wallx-play/ui';
import type { PlaybackReport, PlayKind } from '@wallx-play/shared';
import { Download, FileClock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useScreens, useSites } from '../../content/data';
import { currentLocale } from '../../i18n';
import { call, errorMessage } from '../../lib/api';
import { useOrg } from '../../org/OrgProvider';
import './reports.css';

type Period = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom';
const PERIODS: Period[] = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'custom'];

/** Today's date (YYYY-MM-DD) in the organization's time zone. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function periodRange(period: Exclude<Period, 'custom'>, today: string): { from: string; to: string } {
  const month = today.slice(0, 7);
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: shift(today, -1), to: shift(today, -1) };
    case 'last7':
      return { from: shift(today, -6), to: today };
    case 'last30':
      return { from: shift(today, -29), to: today };
    case 'thisMonth':
      return { from: `${month}-01`, to: today };
    case 'lastMonth': {
      const lastDay = shift(`${month}-01`, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
  }
}

/** CSV with a BOM so Excel opens Hindi/Marathi names correctly. */
export function toCsv(rows: Array<Array<string | number>>): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Proof-of-play: what played where, from the counts players upload every hour. */
export function PlaybackReports() {
  const { t } = useTranslation();
  const { orgId, org, entitlements, siteScope } = useOrg();
  const inPlan = !!entitlements?.features.includes('report.proofOfPlay');
  const timeZone = org?.timezone ?? 'Asia/Kolkata';
  const today = todayIn(timeZone);
  const sites = useSites(orgId);
  const screens = useScreens(orgId, siteScope);
  const [period, setPeriod] = useState<Period>('last7');
  const [custom, setCustom] = useState(() => periodRange('last7', today));
  const [siteId, setSiteId] = useState('');
  const [screenId, setScreenId] = useState('');
  const [report, setReport] = useState<PlaybackReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const range = period === 'custom' ? custom : periodRange(period, today);
  const visibleSites = sites.data.filter((s) => !siteScope.length || siteScope.includes(s.id));
  const siteScreens = screens.data.filter((s) => !siteId || s.siteId === siteId);
  const siteName = useMemo(() => new Map(sites.data.map((s) => [s.id, s.name])), [sites.data]);
  const num = useMemo(() => new Intl.NumberFormat(currentLocale()), []);

  useEffect(() => {
    if (!inPlan || !range.from || !range.to || range.from > range.to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    call<PlaybackReport>('playbackReport', { orgId, from: range.from, to: range.to, siteId: siteId || null, screenId: screenId || null })
      .then((r) => !cancelled && setReport(r))
      .catch((err) => {
        if (!cancelled) {
          setReport(null);
          setError(errorMessage(err));
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [orgId, inPlan, range.from, range.to, siteId, screenId]);

  const duration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h) return t('reports.hm', { h: num.format(h), m });
    if (m) return t('reports.m', { m });
    return t('reports.s', { s: seconds });
  };
  const contentName = (kind: PlayKind, name: string) => name || t(kind === 'media' ? 'reports.deletedMedia' : kind === 'tap' ? 'reports.deletedPage' : 'reports.deletedLayout');

  function exportCsv() {
    if (!report) return;
    const names = new Map(report.byContent.map((c) => [`${c.kind}_${c.id}`, contentName(c.kind, c.name)]));
    const screenNames = new Map(report.byScreen.map((s) => [s.screenId, s.name]));
    const screenSites = new Map(report.byScreen.map((s) => [s.screenId, s.siteId]));
    const csv = toCsv([
      [t('reports.csv.date'), t('reports.csv.screen'), t('reports.csv.site'), t('reports.csv.type'), t('reports.csv.content'), t('reports.csv.contentId'), t('reports.csv.plays'), t('reports.csv.seconds')],
      ...report.rows.map((r) => [
        r.date,
        screenNames.get(r.screenId) || r.screenId,
        siteName.get(screenSites.get(r.screenId) ?? '') ?? '',
        t(`reports.kinds.${r.kind}`),
        names.get(`${r.kind}_${r.id}`) ?? '',
        r.id,
        r.plays,
        r.seconds,
      ]),
    ]);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `playback_${report.from}_${report.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (entitlements && !inPlan) {
    return (
      <>
        <PageHeader title={t('nav.reports')} description={t('reports.description')} />
        <div className="wxp-card">
          <EmptyState icon={<FileClock size={24} aria-hidden />} title={t('reports.notInPlanTitle')} description={t('reports.notInPlanBody')} />
        </div>
      </>
    );
  }

  const maxDay = Math.max(1, ...(report?.byDay.map((d) => d.plays) ?? []));
  const maxHour = Math.max(1, ...(report?.byHour ?? []));

  return (
    <>
      <PageHeader
        title={t('nav.reports')}
        description={t('reports.description')}
        actions={
          <Button onClick={exportCsv} disabled={!report || report.rows.length === 0}>
            <Download size={16} aria-hidden /> {t('reports.exportCsv')}
          </Button>
        }
      />

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
          onChange={(e) => {
            setSiteId(e.target.value);
            setScreenId('');
          }}
          options={[{ value: '', label: t(siteScope.length ? 'reports.mySites' : 'reports.allSites') }, ...visibleSites.map((s) => ({ value: s.id, label: s.name }))]}
        />
        <SelectField
          label={t('reports.screen')}
          value={screenId}
          onChange={(e) => setScreenId(e.target.value)}
          options={[{ value: '', label: t('reports.allScreens') }, ...siteScreens.map((s) => ({ value: s.id, label: s.name }))]}
        />
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {loading && !report ? <Spinner label={t('common.loading')} /> : null}

      {report ? (
        <div className={loading ? 'reports__body reports__body--loading' : 'reports__body'}>
          <div className="reports__totals">
            <Stat label={t('reports.plays')} value={num.format(report.totals.plays)} />
            <Stat label={t('reports.timeOnScreen')} value={duration(report.totals.seconds)} />
            <Stat label={t('reports.screens')} value={num.format(report.totals.screens)} />
            <Stat label={t('reports.items')} value={num.format(report.totals.items)} />
          </div>

          {report.totals.plays === 0 ? (
            <div className="wxp-card">
              <EmptyState icon={<FileClock size={24} aria-hidden />} title={t('reports.emptyTitle')} description={t('reports.emptyBody')} />
            </div>
          ) : (
            <>
              <Card title={t('reports.byContent')}>
                <div className="wxp-table-wrap">
                  <table className="wxp-table">
                    <thead>
                      <tr>
                        <th>{t('reports.content')}</th>
                        <th>{t('reports.type')}</th>
                        <th className="reports__num">{t('reports.plays')}</th>
                        <th className="reports__num">{t('reports.timeOnScreen')}</th>
                        <th className="reports__num">{t('reports.screens')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.byContent.map((c) => (
                        <tr key={`${c.kind}_${c.id}`}>
                          <td className={c.name ? undefined : 'wxp-muted'}>{contentName(c.kind, c.name)}</td>
                          <td>{t(`reports.kinds.${c.kind}`)}</td>
                          <td className="reports__num">{num.format(c.plays)}</td>
                          <td className="reports__num">{duration(c.seconds)}</td>
                          <td className="reports__num">{num.format(c.screens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="reports__charts">
                <Card title={t('reports.byDay')}>
                  <ul className="reports__bars" aria-label={t('reports.byDay')}>
                    {report.byDay.map((d) => (
                      <li key={d.date}>
                        <span className="reports__bar-label">{new Intl.DateTimeFormat(currentLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(`${d.date}T12:00:00Z`))}</span>
                        <span className="reports__bar" style={{ width: `${(d.plays / maxDay) * 100}%` }} aria-hidden />
                        <span className="reports__bar-value">{num.format(d.plays)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
                <Card title={t('reports.byHour')}>
                  <div className="reports__hours" role="img" aria-label={t('reports.byHourAria')}>
                    {report.byHour.map((plays, h) => (
                      <div key={h} className="reports__hour" title={t('reports.hourTip', { h: String(h).padStart(2, '0'), plays: num.format(plays) })}>
                        <span style={{ height: `${(plays / maxHour) * 100}%` }} />
                        {h % 6 === 0 ? <small>{String(h).padStart(2, '0')}</small> : null}
                      </div>
                    ))}
                  </div>
                </Card>
              </div>

              <Card title={t('reports.byScreen')}>
                <div className="wxp-table-wrap">
                  <table className="wxp-table">
                    <thead>
                      <tr>
                        <th>{t('reports.screen')}</th>
                        <th>{t('reports.site')}</th>
                        <th className="reports__num">{t('reports.plays')}</th>
                        <th className="reports__num">{t('reports.timeOnScreen')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.byScreen.map((s) => (
                        <tr key={s.screenId}>
                          <td className={s.name ? undefined : 'wxp-muted'}>{s.name || t('reports.removedScreen')}</td>
                          <td>{(s.siteId && siteName.get(s.siteId)) || '—'}</td>
                          <td className="reports__num">{num.format(s.plays)}</td>
                          <td className="reports__num">{duration(s.seconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
          {report.rowsTruncated ? <Alert tone="warning">{t('reports.truncated')}</Alert> : null}
          <p className="wxp-muted reports__note">{t('reports.note', { tz: report.timezone })}</p>
        </div>
      ) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="wxp-card reports__stat">
      <span className="wxp-muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
