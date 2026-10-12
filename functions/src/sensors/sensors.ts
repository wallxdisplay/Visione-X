/**
 * Sensor devices and channels (management side). Readings arrive through ./ingest.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import { widgetBindings, type Widget } from '@visione-x/layout-spec';
import {
  MAX_CHANNELS_PER_DEVICE,
  INGEST_RATE,
  SENSOR_KEY_PREFIX,
  STALE_COVERED_BY_OFFLINE,
  paths,
  withinLimit,
  type AcknowledgeAlertInput,
  type AlertDoc,
  type DeleteSensorChannelInput,
  type LayoutDoc,
  type PlaylistDoc,
  type SaveSensorChannelInput,
  type SaveSensorDeviceInput,
  type SensorChannelDoc,
  type SensorDeviceDoc,
  type SensorDeviceRefInput,
  type SensorKeyDoc,
} from '@visione-x/shared';
import { userAudit } from '../content/media';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';
import { resolveAlert } from './alerts';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A new API key: `vxs_` + 32 url-safe characters (192 bits). */
export function newSensorKey(): string {
  return SENSOR_KEY_PREFIX + randomBytes(24).toString('base64url');
}

const keyPrefixOf = (key: string) => key.slice(0, SENSOR_KEY_PREFIX.length + 6);

function issueKey(tx: Transaction, db: Firestore, orgId: string, sensorDeviceId: string, at: number): string {
  const key = newSensorKey();
  const doc: SensorKeyDoc = { orgId, sensorDeviceId, createdAt: at };
  tx.create(db.doc(paths.sensorKey(sha256(key))), doc);
  return key;
}

const keysOf = (db: Firestore, orgId: string, sensorDeviceId: string) =>
  db.collection(paths.sensorKeys()).where('orgId', '==', orgId).where('sensorDeviceId', '==', sensorDeviceId);

const openAlertsOf = (db: Firestore, orgId: string, sensorDeviceId: string) =>
  db.collection(paths.alerts(orgId)).where('sensorDeviceId', '==', sensorDeviceId).where('status', '==', 'open');

/** Creates (returns the API key, shown once) or updates a sensor device. */
export async function saveSensorDevice(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SaveSensorDeviceInput>,
): Promise<{ sensorDeviceId: string; apiKey?: string }> {
  const at = now();
  const ref = input.sensorDeviceId
    ? db.doc(paths.sensorDevice(input.orgId, input.sensorDeviceId))
    : db.collection(paths.sensorDevices(input.orgId)).doc();
  let apiKey: string | undefined;

  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'sensor.manage');
    const entitlements = await readEntitlements(tx, db, input.orgId);
    requireFeature(entitlements, 'sensor.esp32', 'Sensors');
    if (input.siteId && !(await tx.get(db.doc(paths.site(input.orgId, input.siteId)))).exists) {
      throw new HttpsError('invalid-argument', 'The selected site no longer exists.');
    }
    const status = input.enabled ? 'active' : 'disabled';

    if (!input.sensorDeviceId) {
      const count = await tx.get(db.collection(paths.sensorDevices(input.orgId)).count());
      if (!withinLimit(entitlements.limits, 'sensorDevices', count.data().count + 1)) {
        throw new HttpsError('resource-exhausted', 'Your plan’s sensor device limit has been reached.');
      }
      apiKey = issueKey(tx, db, input.orgId, ref.id, at);
      const doc: SensorDeviceDoc = {
        id: ref.id,
        name: input.name,
        siteId: input.siteId,
        status,
        keyPrefix: keyPrefixOf(apiKey),
        keyCreatedAt: at,
        offlineAfterMin: input.offlineAfterMin,
        lastSeen: null,
        offlineAt: null,
        firmware: null,
        offlineAlertId: null,
        rate: { tokens: INGEST_RATE.capacity, at },
        channelCount: 0,
        createdBy: actor.uid,
        createdAt: at,
        updatedAt: at,
      };
      tx.create(ref, doc);
      audit(input.orgId, {
        at,
        ...userAudit(actor),
        orgId: input.orgId,
        action: 'sensor.created',
        target: { type: 'sensorDevice', id: ref.id },
        data: { name: input.name },
      });
      return;
    }

    const snap = await tx.get(ref);
    const existing = snap.data() as SensorDeviceDoc | undefined;
    if (!existing) throw new HttpsError('not-found', 'Sensor device not found.');
    const disabling = existing.status === 'active' && status === 'disabled';
    const open = disabling ? await tx.get(openAlertsOf(db, input.orgId, ref.id)) : null;
    const channels = disabling ? await tx.get(db.collection(paths.sensorChannels(input.orgId, ref.id))) : null;
    // While disabled the monitor parks stale channels; watch them again once enabled.
    const parked =
      existing.status === 'disabled' && status === 'active'
        ? await tx.get(db.collection(paths.sensorChannels(input.orgId, ref.id)).where('staleAlertId', '==', STALE_COVERED_BY_OFFLINE))
        : null;

    tx.update(ref, {
      name: input.name,
      siteId: input.siteId,
      status,
      offlineAfterMin: input.offlineAfterMin,
      offlineAt: existing.lastSeen ? existing.lastSeen + input.offlineAfterMin * 60_000 : null,
      ...(disabling ? { offlineAlertId: null } : {}),
      updatedAt: at,
    });
    // A disabled device is not monitored: close its alerts without "back to normal" noise, so
    // that monitoring starts from a clean state when it is enabled again.
    for (const d of open?.docs ?? []) resolveAlert(tx, db, input.orgId, d.data() as AlertDoc, at, true);
    for (const d of [...(channels?.docs ?? []), ...(parked?.docs ?? [])]) tx.update(d.ref, { openAlerts: {}, staleAlertId: null });
    if (existing.status !== status) {
      audit(input.orgId, {
        at,
        ...userAudit(actor),
        orgId: input.orgId,
        action: disabling ? 'sensor.disabled' : 'sensor.enabled',
        target: { type: 'sensorDevice', id: ref.id },
        data: { name: input.name },
      });
    }
  });
  return apiKey ? { sensorDeviceId: ref.id, apiKey } : { sensorDeviceId: ref.id };
}

/** Replaces the device's API key; the old key stops working immediately. */
export async function rotateSensorKey(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SensorDeviceRefInput>,
): Promise<{ apiKey: string }> {
  const at = now();
  const ref = db.doc(paths.sensorDevice(input.orgId, input.sensorDeviceId));
  const apiKey = await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'sensor.manage');
    const device = (await tx.get(ref)).data() as SensorDeviceDoc | undefined;
    if (!device) throw new HttpsError('not-found', 'Sensor device not found.');
    const old = await tx.get(keysOf(db, input.orgId, input.sensorDeviceId));
    old.docs.forEach((d) => tx.delete(d.ref));
    const key = issueKey(tx, db, input.orgId, input.sensorDeviceId, at);
    tx.update(ref, { keyPrefix: keyPrefixOf(key), keyCreatedAt: at, updatedAt: at });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'sensor.keyRotated',
      target: { type: 'sensorDevice', id: input.sensorDeviceId },
      data: { name: device.name },
    });
    return key;
  });
  return { apiKey };
}

/** Names of layouts / playlists showing this device (optionally one channel of it). */
async function usage(tx: Transaction, db: Firestore, orgId: string, sensorDeviceId: string, channelId?: string): Promise<string[]> {
  const [layouts, playlists] = await Promise.all([
    tx.get(db.collection(paths.layouts(orgId)).where('sensorDeviceIds', 'array-contains', sensorDeviceId).limit(50)),
    tx.get(db.collection(paths.playlists(orgId)).where('sensorDeviceIds', 'array-contains', sensorDeviceId).limit(50)),
  ]);
  const binds = (widgets: Widget[]) =>
    !channelId ||
    widgets.some((w) => widgetBindings(w).some((b) => b.binding.sourceId === sensorDeviceId && b.binding.field === channelId));
  const names: string[] = [];
  for (const d of layouts.docs) {
    const l = d.data() as LayoutDoc;
    if (binds(l.zones.flatMap((z) => (z.content.kind === 'widget' ? [z.content.widget] : [])))) names.push(`layout “${l.name}”`);
  }
  for (const d of playlists.docs) {
    const p = d.data() as PlaylistDoc;
    if (binds(p.items.flatMap((i) => (i.content.kind === 'widget' ? [i.content.widget] : [])))) names.push(`playlist “${p.name}”`);
  }
  return names.slice(0, 5);
}

/** Deletes a device with its channels, readings and keys. Alerts stay as history (resolved). */
export async function deleteSensorDevice(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SensorDeviceRefInput>,
): Promise<void> {
  const at = now();
  const ref = db.doc(paths.sensorDevice(input.orgId, input.sensorDeviceId));
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'sensor.manage');
    const device = (await tx.get(ref)).data() as SensorDeviceDoc | undefined;
    if (!device) throw new HttpsError('not-found', 'Sensor device not found.');
    const usedBy = await usage(tx, db, input.orgId, input.sensorDeviceId);
    if (usedBy.length) {
      throw new HttpsError('failed-precondition', `This sensor is shown in ${usedBy.join(', ')}. Remove it there first.`);
    }
    const [keys, open] = await Promise.all([tx.get(keysOf(db, input.orgId, input.sensorDeviceId)), tx.get(openAlertsOf(db, input.orgId, input.sensorDeviceId))]);
    keys.docs.forEach((d) => tx.delete(d.ref));
    open.docs.forEach((d) => resolveAlert(tx, db, input.orgId, d.data() as AlertDoc, at, true));
    // Mark first so ingest stops at once; the subtree is removed after the commit.
    tx.update(ref, { status: 'disabled', updatedAt: at });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'sensor.deleted',
      target: { type: 'sensorDevice', id: input.sensorDeviceId },
      data: { name: device.name },
    });
  });
  await db.recursiveDelete(ref);
}

export async function saveSensorChannel(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SaveSensorChannelInput>,
): Promise<void> {
  const at = now();
  const deviceRef = db.doc(paths.sensorDevice(input.orgId, input.sensorDeviceId));
  const ref = db.doc(paths.sensorChannel(input.orgId, input.sensorDeviceId, input.channelId));
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'sensor.manage');
    const [deviceSnap, snap] = await Promise.all([tx.get(deviceRef), tx.get(ref)]);
    const device = deviceSnap.data() as SensorDeviceDoc | undefined;
    if (!device) throw new HttpsError('not-found', 'Sensor device not found.');
    const existing = snap.data() as SensorChannelDoc | undefined;
    if (input.isNew && existing) throw new HttpsError('already-exists', `Channel “${input.channelId}” already exists on this device.`);
    if (!input.isNew && !existing) throw new HttpsError('not-found', 'Channel not found.');

    const fields = {
      name: input.name,
      unit: input.unit,
      valueType: input.valueType,
      min: input.min,
      max: input.max,
      staleAfterSec: input.staleAfterSec,
      alertRules: input.alertRules,
      updatedAt: at,
    };
    if (!existing) {
      if (device.channelCount >= MAX_CHANNELS_PER_DEVICE) {
        throw new HttpsError('resource-exhausted', `A sensor device can have at most ${MAX_CHANNELS_PER_DEVICE} channels.`);
      }
      const doc: SensorChannelDoc = {
        id: input.channelId,
        ...fields,
        latest: null,
        staleAt: null,
        staleAlertId: null,
        openAlerts: {},
        createdAt: at,
      };
      tx.create(ref, doc);
      tx.update(deviceRef, { channelCount: FieldValue.increment(1), updatedAt: at });
      audit(input.orgId, {
        at,
        ...userAudit(actor),
        orgId: input.orgId,
        action: 'sensor.channelCreated',
        target: { type: 'sensorChannel', id: `${input.sensorDeviceId}/${input.channelId}` },
        data: { name: input.name },
      });
      return;
    }

    // Alerts of removed rules close quietly; changed rules are re-evaluated on the next reading.
    const keep = new Set(input.alertRules.map((r) => r.id));
    const openAlerts = { ...existing.openAlerts };
    for (const [ruleId, alertId] of Object.entries(existing.openAlerts)) {
      if (keep.has(ruleId)) continue;
      resolveAlert(tx, db, input.orgId, { id: alertId, type: 'threshold', sensorName: device.name, channelName: existing.name }, at, true);
      delete openAlerts[ruleId];
    }
    tx.update(ref, {
      ...fields,
      openAlerts,
      staleAt: existing.latest ? existing.latest.ts + input.staleAfterSec * 1000 : null,
    });
  });
}

export async function deleteSensorChannel(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof DeleteSensorChannelInput>,
): Promise<void> {
  const at = now();
  const deviceRef = db.doc(paths.sensorDevice(input.orgId, input.sensorDeviceId));
  const ref = db.doc(paths.sensorChannel(input.orgId, input.sensorDeviceId, input.channelId));
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'sensor.manage');
    const [deviceSnap, snap] = await Promise.all([tx.get(deviceRef), tx.get(ref)]);
    const device = deviceSnap.data() as SensorDeviceDoc | undefined;
    const channel = snap.data() as SensorChannelDoc | undefined;
    if (!device || !channel) throw new HttpsError('not-found', 'Channel not found.');
    const usedBy = await usage(tx, db, input.orgId, input.sensorDeviceId, input.channelId);
    if (usedBy.length) {
      throw new HttpsError('failed-precondition', `This channel is shown in ${usedBy.join(', ')}. Remove it there first.`);
    }
    const alertIds = [...Object.values(channel.openAlerts)];
    if (channel.staleAlertId && channel.staleAlertId !== STALE_COVERED_BY_OFFLINE) alertIds.push(channel.staleAlertId);
    for (const id of alertIds) {
      resolveAlert(tx, db, input.orgId, { id, type: 'threshold', sensorName: device.name, channelName: channel.name }, at, true);
    }
    tx.update(deviceRef, { channelCount: FieldValue.increment(-1), updatedAt: at });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'sensor.channelDeleted',
      target: { type: 'sensorChannel', id: `${input.sensorDeviceId}/${input.channelId}` },
      data: { name: channel.name },
    });
  });
  await db.recursiveDelete(ref);
}

export async function acknowledgeAlert(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof AcknowledgeAlertInput>,
): Promise<void> {
  const ref = db.doc(paths.alert(input.orgId, input.alertId));
  await db.runTransaction(async (tx) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'sensor.manage');
    const alert = (await tx.get(ref)).data() as AlertDoc | undefined;
    if (!alert) throw new HttpsError('not-found', 'Alert not found.');
    if (alert.acknowledgedAt) return;
    tx.update(ref, { acknowledgedBy: actor.uid, acknowledgedByEmail: actor.email, acknowledgedAt: now() });
  });
}
