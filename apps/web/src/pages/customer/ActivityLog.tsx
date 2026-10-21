import { Alert, Button, EmptyState, PageHeader, Spinner } from '@wallx-play/ui';
import type { ActivityEntry } from '@wallx-play/shared';
import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { call, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';

/** "screen.apps.assigned" → "Screen apps assigned" when there is no translated label. */
function readable(action: string): string {
  const words = action
    .split('.')
    .flatMap((part) => part.replace(/([a-z])([A-Z])/g, '$1 $2').split(' '))
    .map((w) => w.toLowerCase());
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Organization activity: who did what and when (members with "See the activity log"). */
export function ActivityLog() {
  const { t } = useTranslation();
  const { orgId, can } = useOrg();
  const allowed = can('audit.view');
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(allowed);
  const [error, setError] = useState<string | null>(null);

  async function load(before?: number) {
    setLoading(true);
    setError(null);
    try {
      const r = await call<{ entries: ActivityEntry[]; more: boolean }>('orgActivity', { orgId, ...(before ? { before } : {}) });
      setEntries((all) => (before ? [...all, ...r.entries] : r.entries));
      setMore(r.more);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (allowed) void load();
  }, [orgId, allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  const who = (e: ActivityEntry) =>
    e.actorType === 'user' ? (e.actorEmail ?? t('activity.member')) : e.actorType === 'platform_user' ? t('activity.wallx') : e.actorType === 'api_key' ? t('activity.apiKey') : t('activity.system');

  return (
    <>
      <PageHeader title={t('nav.activity')} description={t('activity.description')} />
      {!allowed ? (
        <div className="wxp-card">
          <EmptyState icon={<History size={24} aria-hidden />} title={t('activity.noAccessTitle')} description={t('activity.noAccessBody')} />
        </div>
      ) : (
        <>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {loading && entries.length === 0 ? (
            <Spinner label={t('common.loading')} />
          ) : entries.length === 0 ? (
            <p className="wxp-muted">{t('activity.empty')}</p>
          ) : (
            <div className="wxp-table-wrap">
              <table className="wxp-table">
                <thead>
                  <tr>
                    <th>{t('activity.when')}</th>
                    <th>{t('activity.who')}</th>
                    <th>{t('activity.what')}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={`${e.at}-${i}`}>
                      <td className="wxp-tabular">{formatDateTime(e.at)}</td>
                      <td>{who(e)}</td>
                      <td>
                        {t(`activity.actions.${e.action.replace(/\./g, '_')}`, { defaultValue: readable(e.action) })}
                        {e.reason ? <div className="wxp-muted">{t('activity.reason', { reason: e.reason })}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {more ? (
            <Button disabled={loading} onClick={() => void load(entries[entries.length - 1]?.at)}>
              {t('activity.older')}
            </Button>
          ) : null}
          <p className="wxp-muted" style={{ marginTop: 16 }}>
            {t('activity.note')}
          </p>
        </>
      )}
    </>
  );
}
