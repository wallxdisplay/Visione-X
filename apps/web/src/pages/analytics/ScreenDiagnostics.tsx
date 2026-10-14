import { Alert, Button, Dialog, StatusChip, type StatusTone } from '@wallx-play/ui';
import { paths, type ScreenAnalytics, type ScreenDoc, type ScreenEventDoc, type ScreenEventType } from '@wallx-play/shared';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';
import { db } from '../../lib/firebase';
import { formatDateTime } from '../../lib/format';
import { useQueryData } from '../../lib/hooks';
import { periodRange, todayIn } from '../reports/PlaybackReports';
import './analytics.css';

const EVENT_TONE: Record<ScreenEventType, StatusTone> = { error: 'danger', offline: 'warning', online: 'success', updated: 'info' };

export const percent = (share: number | null) => (share === null ? '—' : `${Math.round(share * 1000) / 10}%`);

/** Minutes as "3 d 4 h" / "5 h 12 min" / "8 min". */
export function uptimeText(t: (k: string, o?: Record<string, unknown>) => string, minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) return t('analytics.dh', { d, h });
  if (h) return t('analytics.hm', { h, m });
  return t('analytics.m', { m });
}

/** Health, 7-day uptime and the recent history of one screen. */
export function ScreenDiagnostics({ orgId, screen, timezone, onClose }: { orgId: string; screen: ScreenDoc; timezone: string; onClose: () => void }) {
  const { t } = useTranslation();
  const events = useQueryData<ScreenEventDoc>(`events:${orgId}:${screen.id}`, () =>
    query(collection(db, paths.screenEvents(orgId, screen.id)), orderBy('at', 'desc'), limit(50)),
  );
  const [week, setWeek] = useState<ScreenAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const range = periodRange('last7', todayIn(timezone));
    call<ScreenAnalytics>('screenAnalytics', { orgId, ...range, siteId: null, screenId: screen.id })
      .then(setWeek)
      .catch((err) => setError(errorMessage(err)));
  }, [orgId, screen.id, timezone]);

  const h = screen.health;
  const v = h?.vitals;
  const rows: Array<[string, string]> = [
    [t('analytics.diag.app'), h ? `v${h.appVersion}` : '—'],
    [t('analytics.diag.lastReport'), h ? formatDateTime(h.reportedAt) : '—'],
    [t('analytics.diag.network'), v ? t(`analytics.networks.${v.network}`) : '—'],
    [t('analytics.diag.memory'), v ? t('analytics.diag.memoryValue', { free: v.memAvailMb, total: v.memTotalMb }) : '—'],
    [t('analytics.diag.storage'), h?.storageFreeMb != null ? t('analytics.diag.storageValue', { mb: h.storageFreeMb }) : '—'],
    [t('analytics.diag.deviceUp'), v ? uptimeText(t, v.deviceUptimeMin) : '—'],
    [t('analytics.diag.appUp'), v ? uptimeText(t, v.appUptimeMin) : '—'],
    [t('analytics.diag.display'), h ? `${h.display.width}×${h.display.height}` : '—'],
  ];

  return (
    <Dialog open title={t('analytics.diag.title', { name: screen.name })} onClose={onClose} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {!v && h ? <Alert tone="info">{t('analytics.diag.oldPlayer')}</Alert> : null}
      <dl className="analytics__vitals">
        {rows.map(([k, val]) => (
          <div key={k}>
            <dt className="wxp-muted">{k}</dt>
            <dd className="wxp-tabular">{val}</dd>
          </div>
        ))}
      </dl>

      <h3 className="analytics__subtitle">{t('analytics.diag.week')}</h3>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {week ? (
        week.totals.screensWithData === 0 ? (
          <p className="wxp-muted">{t('analytics.noUptime')}</p>
        ) : (
          <ul className="analytics__days">
            {week.byDay.map((d) => (
              <li key={d.date}>
                <span>{new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(`${d.date}T12:00:00Z`))}</span>
                <span className="analytics__meter" aria-hidden>
                  <span style={{ width: `${(d.onShare ?? 0) * 100}%` }} />
                </span>
                <span className="wxp-tabular">{percent(d.onShare)}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <h3 className="analytics__subtitle">{t('analytics.diag.history')}</h3>
      {events.data.length === 0 ? (
        <p className="wxp-muted">{t('analytics.diag.noEvents')}</p>
      ) : (
        <ul className="analytics__events">
          {events.data.map((e) => (
            <li key={e._id}>
              <StatusChip tone={EVENT_TONE[e.type]}>{t(`analytics.events.${e.type}`)}</StatusChip>
              <span className="wxp-muted wxp-tabular">{formatDateTime(e.at)}</span>
              {e.message ? <span className="analytics__message">{e.message}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
