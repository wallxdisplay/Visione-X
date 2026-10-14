import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { COMMAND_EXPIRY_MS, OFFLINE_AFTER_MS, REGION, type EmergencyDoc, type ScreenDoc } from '@wallx-play/shared';
import { getDeps } from '../lib/admin';
import type { Deps } from '../lib/context';
import { notify } from '../lib/notify';
import { endEmergency } from './emergency';
import { runSensorMonitor } from '../sensors/monitor';
import { runBillingMonitor } from '../billing/monitor';
import { expireSupportGrants } from '../support/access';

/**
 * Periodic housekeeping across all orgs:
 *  - screens silent for longer than OFFLINE_AFTER_MS get one "offline" alert (cleared by the
 *    next heartbeat, which raises "back online"),
 *  - emergency overrides past their end time are ended and normal content republished,
 *  - commands never picked up are marked expired,
 *  - sensor devices and channels that stopped reporting raise alerts (sensors/monitor.ts),
 *  - subscriptions move between trial / active / past due / restricted (billing/monitor.ts).
 */
export async function runMonitor(
  deps: Deps,
): Promise<{
  offline: number;
  emergencies: number;
  commands: number;
  sensorsOffline: number;
  channelsStale: number;
  billingTransitions: number;
  billingReminders: number;
  supportExpired: number;
}> {
  const { db, now } = deps;
  const at = now();

  const offline = await db
    .collectionGroup('screens')
    .where('status', '==', 'authorized')
    .where('offlineAlertedAt', '==', null)
    .where('lastSeen', '<', at - OFFLINE_AFTER_MS)
    .limit(400)
    .get();
  if (!offline.empty) {
    const batch = db.batch();
    for (const doc of offline.docs) {
      const screen = doc.data() as ScreenDoc;
      const orgId = doc.ref.parent.parent!.id;
      batch.update(doc.ref, { offlineAlertedAt: at });
      notify(batch, db, orgId, 'screen_offline', { screen: screen.name, lastSeen: screen.lastSeen ?? 0 }, '/screens', at);
    }
    await batch.commit();
  }

  const expired = await db.collectionGroup('emergencies').where('active', '==', true).where('expiresAt', '<=', at).get();
  for (const doc of expired.docs) {
    const e = doc.data() as EmergencyDoc;
    try {
      await endEmergency(deps, null, { orgId: doc.ref.parent.parent!.id, emergencyId: e.id });
    } catch (err) {
      logger.warn('Could not end expired emergency', { id: e.id, err: String(err) });
    }
  }

  const stale = await db
    .collectionGroup('commands')
    .where('status', 'in', ['pending', 'delivered'])
    .where('createdAt', '<', at - COMMAND_EXPIRY_MS)
    .limit(400)
    .get();
  if (!stale.empty) {
    const batch = db.batch();
    stale.docs.forEach((d) => batch.update(d.ref, { status: 'expired', completedAt: at }));
    await batch.commit();
  }

  const sensors = await runSensorMonitor(deps);
  const billing = await runBillingMonitor(deps);
  const supportExpired = await expireSupportGrants(deps);
  return {
    offline: offline.size,
    emergencies: expired.size,
    commands: stale.size,
    sensorsOffline: sensors.offline,
    channelsStale: sensors.stale,
    billingTransitions: billing.transitions,
    billingReminders: billing.reminders,
    supportExpired,
  };
}

export const monitorScreens = onSchedule(
  { schedule: 'every 5 minutes', region: REGION, timeZone: 'Asia/Kolkata', memory: '256MiB', maxInstances: 1, retryCount: 0 },
  async () => {
    const result = await runMonitor(getDeps());
    if (Object.values(result).some(Boolean)) logger.info('Monitor run', result);
  },
);
