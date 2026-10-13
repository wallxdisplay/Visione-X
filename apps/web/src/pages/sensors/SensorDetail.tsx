import { Alert, Button, Dialog, EmptyState, PageHeader, Spinner, StatusChip } from '@wallx-play/ui';
import { formatLiveValue, liveState } from '@wallx-play/layout-spec';
import { isSensorOnline, paths, type SensorChannelDoc, type SensorDeviceDoc } from '@wallx-play/shared';
import { ArrowLeft, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useSites } from '../../content/data';
import { useReadings, useSensorChannels } from '../../content/sensors';
import { call, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useDoc } from '../../lib/hooks';
import { useOrg } from '../../org/OrgProvider';
import { SERIES_COLORS, SeriesChart } from '../../render/SeriesChart';
import { ApiKeyDialog, ChannelDialog, SensorDeviceDialog, ingestUrl } from './SensorDialogs';
import { sensorState } from './Sensors';
import './sensors.css';

const RANGES = [60, 360, 1440];

function channelState(c: SensorChannelDoc, device: SensorDeviceDoc): { key: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (Object.keys(c.openAlerts).length) return { key: 'alert', tone: 'danger' };
  const state = liveState(
    c.latest ? { value: c.latest.value, ts: c.latest.ts, staleAfterSec: c.staleAfterSec, deviceOnline: device.status === 'active' && isSensorOnline(device) } : null,
    Date.now(),
  );
  if (state === 'ok') return { key: 'ok', tone: 'success' };
  if (state === 'nodata') return { key: 'nodata', tone: 'neutral' };
  return { key: state, tone: 'warning' };
}

const display = (c: SensorChannelDoc, v: number, t: (k: string) => string) =>
  c.valueType === 'boolean' ? (v ? t('channels.on') : t('channels.off')) : `${formatLiveValue(v)}${c.unit ? ` ${c.unit}` : ''}`;

function ChannelChart({ orgId, deviceId, channel, minutes }: { orgId: string; deviceId: string; channel: SensorChannelDoc; minutes: number }) {
  const { t } = useTranslation();
  const { points, loading } = useReadings(orgId, deviceId, channel.id, minutes);
  const now = Date.now();
  const recent = points.slice(-12).reverse();
  return (
    <section className="wxp-card channel-chart">
      <h3 className="channel-chart__title">
        {channel.name}
        {channel.unit ? <span className="wxp-muted"> · {channel.unit}</span> : null}
      </h3>
      <div className="channel-chart__plot">
        {loading ? (
          <Spinner label={t('common.loading')} />
        ) : (
          <SeriesChart
            series={[{ key: channel.id, label: channel.name, color: SERIES_COLORS.light[0], points }]}
            kind={channel.valueType === 'boolean' ? 'bar' : 'line'}
            from={now - minutes * 60_000}
            to={now}
            unit={channel.unit}
            textColor="var(--color-ink)"
            mutedColor="var(--color-ink-muted)"
            gridColor="var(--color-border)"
            surfaceColor="var(--color-surface)"
            interactive
            emptyLabel={t('channels.noReadings')}
          />
        )}
      </div>
      {recent.length ? (
        <details className="channel-chart__table">
          <summary>{t('channels.showReadings')}</summary>
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('channels.time')}</th>
                <th>{t('channels.value')}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(([ts, v]) => (
                <tr key={ts}>
                  <td>{formatDateTime(ts)}</td>
                  <td className="wxp-tabular">{display(channel, v, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </section>
  );
}

export function SensorDetail() {
  const { t } = useTranslation();
  const { sensorDeviceId = '' } = useParams();
  const navigate = useNavigate();
  const { orgId, can } = useOrg();
  const device = useDoc<SensorDeviceDoc>(paths.sensorDevice(orgId, sensorDeviceId));
  const channels = useSensorChannels(orgId, sensorDeviceId);
  const sites = useSites(orgId);
  const manage = can('sensor.manage');
  const [editing, setEditing] = useState(false);
  const [channelDialog, setChannelDialog] = useState<{ channel: SensorChannelDoc | null } | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | { channel: SensorChannelDoc } | null>(null);
  const [newKey, setNewKey] = useState<{ name: string; apiKey: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState(360);

  if (device.loading) return <Spinner label={t('common.loading')} />;
  const d = device.data;
  if (!d) {
    return (
      <div className="wxp-card">
        <EmptyState title={t('sensors.notFound')} action={<Link to="/sensors">{t('sensors.back')}</Link>} />
      </div>
    );
  }
  const state = sensorState(d);

  async function runConfirm() {
    if (!confirm || !d) return;
    setBusy(true);
    setError(null);
    try {
      if (confirm === 'rotate') {
        const { apiKey } = await call<{ apiKey: string }>('rotateSensorKey', { orgId, sensorDeviceId });
        setNewKey({ name: d.name, apiKey });
      } else if (confirm === 'delete') {
        await call('deleteSensorDevice', { orgId, sensorDeviceId });
        navigate('/sensors');
        return;
      } else {
        await call('deleteSensorChannel', { orgId, sensorDeviceId, channelId: confirm.channel.id });
      }
      setConfirm(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Link to="/sensors" className="back-link">
        <ArrowLeft size={14} aria-hidden /> {t('sensors.back')}
      </Link>
      <PageHeader
        title={
          <span className="sensor-title">
            {d.name} <StatusChip tone={state.tone}>{t(`sensors.states.${state.key}`)}</StatusChip>
          </span>
        }
        actions={
          manage ? (
            <div className="wxp-toolbar" style={{ margin: 0 }}>
              <Button onClick={() => setEditing(true)}>
                <Pencil size={14} aria-hidden /> {t('common.edit')}
              </Button>
              <Button onClick={() => setConfirm('rotate')}>
                <KeyRound size={14} aria-hidden /> {t('sensors.rotateKey')}
              </Button>
              <Button variant="tertiary" onClick={() => setConfirm('delete')}>
                <Trash2 size={14} aria-hidden /> {t('common.delete')}
              </Button>
            </div>
          ) : null
        }
      />
      {error && !confirm ? <Alert tone="danger">{error}</Alert> : null}

      <div className="wxp-card">
        <dl className="wxp-dl sensor-facts">
          <dt>{t('sensors.lastSeen')}</dt>
          <dd>{formatDateTime(d.lastSeen)}</dd>
          <dt>{t('sensors.site')}</dt>
          <dd>{sites.data.find((s) => s.id === d.siteId)?.name ?? '—'}</dd>
          <dt>{t('sensors.offlineAfter')}</dt>
          <dd>{t('sensors.minutes', { count: d.offlineAfterMin })}</dd>
          <dt>{t('sensors.firmware')}</dt>
          <dd>{d.firmware ?? '—'}</dd>
          <dt>{t('sensors.apiKey')}</dt>
          <dd>
            <code>{d.keyPrefix}…</code> <span className="wxp-muted">({formatDateTime(d.keyCreatedAt)})</span>
          </dd>
          <dt>{t('sensors.deviceId')}</dt>
          <dd>
            <code>{d.id}</code>
          </dd>
          <dt>{t('sensors.endpoint')}</dt>
          <dd>
            <code>{ingestUrl()}</code>
          </dd>
        </dl>
      </div>

      <div className="section-head">
        <h2 className="section-title">{t('channels.title')}</h2>
        {manage ? (
          <Button size="sm" onClick={() => setChannelDialog({ channel: null })}>
            <Plus size={14} aria-hidden /> {t('channels.add')}
          </Button>
        ) : null}
      </div>
      {channels.data.length === 0 && !channels.loading ? (
        <p className="wxp-muted">{t('channels.empty')}</p>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('channels.name')}</th>
                <th>{t('channels.key')}</th>
                <th>{t('channels.latest')}</th>
                <th>{t('channels.state')}</th>
                <th>{t('channels.updated')}</th>
                <th aria-label={t('common.actions')} />
              </tr>
            </thead>
            <tbody>
              {channels.data.map((c) => {
                const s = channelState(c, d);
                return (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>
                      <code>{c.id}</code>
                    </td>
                    <td className="wxp-tabular">{c.latest ? display(c, c.latest.value, t) : '—'}</td>
                    <td>
                      <StatusChip tone={s.tone}>{t(`channels.states.${s.key}`)}</StatusChip>
                    </td>
                    <td>{formatDateTime(c.latest?.ts)}</td>
                    <td className="wxp-actions">
                      {manage ? (
                        <>
                          <Button size="sm" variant="tertiary" onClick={() => setChannelDialog({ channel: c })}>
                            {t('common.edit')}
                          </Button>
                          <Button size="sm" variant="tertiary" onClick={() => setConfirm({ channel: c })}>
                            {t('common.delete')}
                          </Button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {channels.data.length ? (
        <>
          <div className="section-head">
            <h2 className="section-title">{t('channels.history')}</h2>
            <div className="range-toggle" role="group" aria-label={t('channels.range')}>
              {RANGES.map((m) => (
                <button key={m} type="button" className={m === minutes ? 'is-active' : ''} aria-pressed={m === minutes} onClick={() => setMinutes(m)}>
                  {t('channels.lastHours', { count: m / 60 })}
                </button>
              ))}
            </div>
          </div>
          <div className="channel-charts">
            {channels.data.map((c) => (
              <ChannelChart key={c.id} orgId={orgId} deviceId={sensorDeviceId} channel={c} minutes={minutes} />
            ))}
          </div>
        </>
      ) : null}

      <SensorDeviceDialog open={editing} device={d} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />
      <ChannelDialog open={!!channelDialog} sensorDeviceId={sensorDeviceId} channel={channelDialog?.channel ?? null} onClose={() => setChannelDialog(null)} />
      <ApiKeyDialog value={newKey} onClose={() => setNewKey(null)} />
      <Dialog
        open={!!confirm}
        title={confirm === 'rotate' ? t('sensors.rotateTitle') : confirm === 'delete' ? t('sensors.deleteTitle') : t('channels.deleteTitle')}
        onClose={() => {
          setConfirm(null);
          setError(null);
        }}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button variant={confirm === 'rotate' ? 'primary' : 'danger'} disabled={busy} onClick={() => void runConfirm()}>
              {confirm === 'rotate' ? t('sensors.rotateKey') : t('common.delete')}
            </Button>
          </>
        }
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p>
          {confirm === 'rotate'
            ? t('sensors.rotateBody')
            : confirm === 'delete'
              ? t('sensors.deleteBody', { name: d.name })
              : confirm
                ? t('channels.deleteBody', { name: confirm.channel.name })
                : null}
        </p>
      </Dialog>
    </>
  );
}
