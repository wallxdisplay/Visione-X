import { Alert, Button, EmptyState, PageHeader, StatusChip } from '@wallx-play/ui';
import { isSensorOnline, type SensorDeviceDoc } from '@wallx-play/shared';
import { Plus, Radio } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useSites } from '../../content/data';
import { useSensorDevices } from '../../content/sensors';
import { formatDateTime } from '../../lib/format';
import { useOrg } from '../../org/OrgProvider';
import { ApiKeyDialog, SensorDeviceDialog } from './SensorDialogs';
import './sensors.css';

type Tone = 'success' | 'danger' | 'warning' | 'neutral';

export function sensorState(d: SensorDeviceDoc): { key: string; tone: Tone } {
  if (d.status === 'disabled') return { key: 'disabled', tone: 'neutral' };
  if (!d.lastSeen) return { key: 'neverSeen', tone: 'neutral' };
  return isSensorOnline(d) ? { key: 'online', tone: 'success' } : { key: 'offline', tone: 'danger' };
}

/** Sensor devices of the org (ESP32 and similar). */
export function Sensors() {
  const { t } = useTranslation();
  const { orgId, can, entitlements } = useOrg();
  const entitled = !!entitlements?.features.includes('sensor.esp32');
  const devices = useSensorDevices(orgId, entitled && can('sensor.view'));
  const sites = useSites(orgId);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState<{ name: string; apiKey: string } | null>(null);
  const manage = can('sensor.manage');
  const limit = entitlements?.limits.sensorDevices;

  if (entitlements && !entitled) {
    return (
      <>
        <PageHeader title={t('nav.sensors')} description={t('sensors.description')} />
        <div className="wxp-card">
          <EmptyState icon={<Radio size={24} aria-hidden />} title={t('sensors.notInPlanTitle')} description={t('sensors.notInPlanBody')} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('nav.sensors')}
        description={t('sensors.description')}
        actions={
          manage ? (
            <Button variant="primary" onClick={() => setAdding(true)} disabled={limit !== null && limit !== undefined && devices.data.length >= limit}>
              <Plus size={16} aria-hidden /> {t('sensors.add')}
            </Button>
          ) : null
        }
      />
      {limit !== null && limit !== undefined && devices.data.length >= limit && manage ? (
        <Alert tone="info">{t('sensors.limitReached', { count: limit })}</Alert>
      ) : null}

      {devices.data.length === 0 && !devices.loading ? (
        <div className="wxp-card">
          <EmptyState
            icon={<Radio size={24} aria-hidden />}
            title={t('sensors.emptyTitle')}
            description={t('sensors.emptyBody')}
            action={manage ? <Button variant="primary" onClick={() => setAdding(true)}>{t('sensors.add')}</Button> : undefined}
          />
        </div>
      ) : (
        <div className="wxp-table-wrap">
          <table className="wxp-table">
            <thead>
              <tr>
                <th>{t('sensors.name')}</th>
                <th>{t('sensors.status')}</th>
                <th>{t('sensors.site')}</th>
                <th>{t('sensors.channels')}</th>
                <th>{t('sensors.lastSeen')}</th>
              </tr>
            </thead>
            <tbody>
              {devices.data.map((d) => {
                const s = sensorState(d);
                return (
                  <tr key={d.id}>
                    <td>
                      <Link to={`/sensors/${d.id}`}>{d.name}</Link>
                    </td>
                    <td>
                      <StatusChip tone={s.tone}>{t(`sensors.states.${s.key}`)}</StatusChip>
                    </td>
                    <td>{sites.data.find((x) => x.id === d.siteId)?.name ?? '—'}</td>
                    <td className="wxp-tabular">{d.channelCount}</td>
                    <td>{formatDateTime(d.lastSeen)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SensorDeviceDialog
        open={adding}
        device={null}
        onClose={() => setAdding(false)}
        onSaved={(r, name) => {
          setAdding(false);
          if (r.apiKey) setNewKey({ name, apiKey: r.apiKey });
        }}
      />
      <ApiKeyDialog value={newKey} onClose={() => setNewKey(null)} />
    </>
  );
}
