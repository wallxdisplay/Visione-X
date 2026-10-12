import type { Firestore, Transaction, WriteBatch } from 'firebase-admin/firestore';
import { paths, type AlertDoc } from '@visione-x/shared';
import { notify } from '../lib/notify';

type Writer = Transaction | WriteBatch;

export type NewAlert = Omit<
  AlertDoc,
  'id' | 'status' | 'openedAt' | 'resolvedAt' | 'lastValue' | 'acknowledgedBy' | 'acknowledgedByEmail' | 'acknowledgedAt'
>;

/** Opens an alert and notifies the org. Returns the alert id. */
export function openAlert(writer: Writer, db: Firestore, orgId: string, alert: NewAlert, at: number): string {
  const ref = db.collection(paths.alerts(orgId)).doc();
  const doc: AlertDoc = {
    ...alert,
    id: ref.id,
    status: 'open',
    openedAt: at,
    resolvedAt: null,
    lastValue: alert.value,
    acknowledgedBy: null,
    acknowledgedByEmail: null,
    acknowledgedAt: null,
  };
  (writer as WriteBatch).set(ref, doc);
  const sensor = alert.sensorName;
  const channel = alert.channelName ?? '';
  if (alert.type === 'offline') notify(writer, db, orgId, 'sensor_offline', { sensor }, '/alerts', at);
  else if (alert.type === 'stale') notify(writer, db, orgId, 'sensor_stale', { sensor, channel }, '/alerts', at);
  else {
    notify(
      writer,
      db,
      orgId,
      'sensor_alert',
      { sensor, channel, rule: alert.ruleLabel ?? '', value: alert.value ?? '', unit: alert.unit ?? '' },
      '/alerts',
      at,
    );
  }
  return ref.id;
}

/**
 * Resolves an open alert. `quiet` skips the "back to normal" notification (used when the
 * channel or device was edited or removed rather than recovering).
 */
export function resolveAlert(
  writer: Writer,
  db: Firestore,
  orgId: string,
  alert: Pick<AlertDoc, 'id' | 'type' | 'sensorName' | 'channelName'>,
  at: number,
  quiet = false,
): void {
  (writer as WriteBatch).update(db.doc(paths.alert(orgId, alert.id)), { status: 'resolved', resolvedAt: at });
  if (quiet) return;
  if (alert.type === 'offline') notify(writer, db, orgId, 'sensor_online', { sensor: alert.sensorName }, '/alerts', at);
  else notify(writer, db, orgId, 'sensor_recovered', { sensor: alert.sensorName, channel: alert.channelName ?? '' }, '/alerts', at);
}
