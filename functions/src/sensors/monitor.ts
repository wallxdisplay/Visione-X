import type { DocumentReference } from 'firebase-admin/firestore';
import { STALE_COVERED_BY_OFFLINE, type SensorChannelDoc, type SensorDeviceDoc } from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import { openAlert } from './alerts';

/**
 * Sensor part of the periodic monitor:
 *  - active devices silent past `offlineAt` get one offline alert (closed by their next request),
 *  - channels past `staleAt` while their device is still reporting get one stale alert (closed
 *    by the next reading). Channels of offline or disabled devices are parked instead, so the
 *    offline alert is the only one raised for a dead device.
 */
export async function runSensorMonitor({ db, now }: Deps): Promise<{ offline: number; stale: number }> {
  const at = now();

  const offline = await db
    .collectionGroup('sensorDevices')
    .where('status', '==', 'active')
    .where('offlineAlertId', '==', null)
    .where('offlineAt', '<=', at)
    .limit(400)
    .get();
  if (!offline.empty) {
    const batch = db.batch();
    for (const doc of offline.docs) {
      const d = doc.data() as SensorDeviceDoc;
      const orgId = doc.ref.parent.parent!.id;
      const alertId = openAlert(
        batch,
        db,
        orgId,
        {
          type: 'offline',
          severity: 'critical',
          sensorDeviceId: d.id,
          siteId: d.siteId,
          sensorName: d.name,
          channelId: null,
          channelName: null,
          unit: null,
          ruleId: null,
          ruleLabel: null,
          operator: null,
          limit: null,
          value: null,
        },
        at,
      );
      batch.update(doc.ref, { offlineAlertId: alertId });
    }
    await batch.commit();
  }

  const stale = await db
    .collectionGroup('channels')
    .where('staleAlertId', '==', null)
    .where('staleAt', '<=', at)
    .limit(400)
    .get();
  let raised = 0;
  if (!stale.empty) {
    const devices = new Map<string, SensorDeviceDoc | undefined>();
    for (const ref of new Set(stale.docs.map((d) => d.ref.parent.parent!.path))) {
      devices.set(ref, (await db.doc(ref).get()).data() as SensorDeviceDoc | undefined);
    }
    const batch = db.batch();
    for (const doc of stale.docs) {
      const deviceRef = doc.ref.parent.parent as DocumentReference;
      const device = devices.get(deviceRef.path);
      const channel = doc.data() as SensorChannelDoc;
      const deviceDown =
        !device || device.status !== 'active' || device.offlineAlertId !== null || (device.offlineAt !== null && device.offlineAt <= at);
      if (deviceDown) {
        batch.update(doc.ref, { staleAlertId: STALE_COVERED_BY_OFFLINE });
        continue;
      }
      const alertId = openAlert(
        batch,
        db,
        deviceRef.parent.parent!.id,
        {
          type: 'stale',
          severity: 'warning',
          sensorDeviceId: device.id,
          siteId: device.siteId,
          sensorName: device.name,
          channelId: channel.id,
          channelName: channel.name,
          unit: channel.unit,
          ruleId: null,
          ruleLabel: null,
          operator: null,
          limit: null,
          value: channel.latest?.value ?? null,
        },
        at,
      );
      batch.update(doc.ref, { staleAlertId: alertId });
      raised++;
    }
    await batch.commit();
  }
  return { offline: offline.size, stale: raised };
}
