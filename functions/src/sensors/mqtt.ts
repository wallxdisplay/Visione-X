/**
 * MQTT sensors (Enterprise, `sensor.mqtt`): brokers, the bridge configuration players fetch and
 * the readings bridges forward. A broker is reached through one of the org's screens at the
 * site (its player connects to the broker), so no cloud service has to reach the customer's
 * network. Readings go through the same ingest core as ESP32 devices.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  MAX_MQTT_BROKERS,
  MqttReadingsBody,
  paths,
  type DeviceDoc,
  type DeviceMqttResponse,
  type EntitlementsDoc,
  type MqttBrokerDoc,
  type MqttBrokerRefInput,
  type MqttBrokerSecretDoc,
  type MqttReadingsResponse,
  type OrgDoc,
  type SaveMqttBrokerInput,
  type ScreenDoc,
  type SensorChannelDoc,
  type SensorDeviceDoc,
} from '@wallx-play/shared';
import { userAudit } from '../content/media';
import { authenticate, type ApiRequest, type ApiResult } from '../devices/deviceApi';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission, requireSiteInScope } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';
import { ingestReadings } from './ingest';

const fail = (status: number, error: string, message: string): ApiResult => ({ status, body: { error, message } });

export const mqttEntitled = (e: Pick<EntitlementsDoc, 'features'> | undefined) =>
  !!e?.features.includes('sensor.esp32') && !!e.features.includes('sensor.mqtt');

const brokersBridgedBy = (db: Firestore, orgId: string, screenId: string) =>
  db.collection(paths.mqttBrokers(orgId)).where('bridgeScreenId', '==', screenId);

/** Clears a former bridge screen's flag unless it still bridges another broker (reads only). */
async function stillBridges(tx: Transaction, db: Firestore, orgId: string, screenId: string, exceptBrokerId: string): Promise<boolean> {
  const others = await tx.get(brokersBridgedBy(db, orgId, screenId).limit(2));
  return others.docs.some((d) => d.id !== exceptBrokerId);
}

export async function saveMqttBroker(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SaveMqttBrokerInput>,
): Promise<{ brokerId: string }> {
  const at = now();
  const ref = input.brokerId ? db.doc(paths.mqttBroker(input.orgId, input.brokerId)) : db.collection(paths.mqttBrokers(input.orgId)).doc();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'sensor.manage');
    const entitlements = await readEntitlements(tx, db, input.orgId);
    requireFeature(entitlements, 'sensor.esp32', 'Sensors');
    requireFeature(entitlements, 'sensor.mqtt', 'MQTT sensors');
    const [beforeSnap, screenSnap] = await Promise.all([tx.get(ref), tx.get(db.doc(paths.screen(input.orgId, input.bridgeScreenId)))]);
    const before = beforeSnap.data() as MqttBrokerDoc | undefined;
    if (input.brokerId && !before) throw new HttpsError('not-found', 'MQTT broker not found.');
    if (before) requireSiteInScope(member, before.siteId, 'this MQTT broker');
    const screen = screenSnap.data() as ScreenDoc | undefined;
    if (!screen) throw new HttpsError('invalid-argument', 'The bridge screen no longer exists.');
    if (screen.status !== 'authorized') throw new HttpsError('failed-precondition', `Authorize “${screen.name}” before using it as a bridge.`);
    requireSiteInScope(member, screen.siteId, `“${screen.name}”`);
    if (!before) {
      const count = await tx.get(db.collection(paths.mqttBrokers(input.orgId)).count());
      if (count.data().count >= MAX_MQTT_BROKERS) throw new HttpsError('resource-exhausted', `An organization can have at most ${MAX_MQTT_BROKERS} MQTT brokers.`);
    }
    const oldBridge = before && before.bridgeScreenId !== input.bridgeScreenId ? before.bridgeScreenId : null;
    const oldStillBridges = oldBridge ? await stillBridges(tx, db, input.orgId, oldBridge, ref.id) : false;
    const oldBridgeExists = oldBridge ? (await tx.get(db.doc(paths.screen(input.orgId, oldBridge)))).exists : false;

    const hasPassword = input.password === undefined ? !!before?.hasPassword : input.password !== null;
    const doc: MqttBrokerDoc = {
      id: ref.id,
      name: input.name,
      host: input.host,
      port: input.port,
      tls: input.tls,
      username: input.username?.trim() || null,
      hasPassword,
      bridgeScreenId: input.bridgeScreenId,
      siteId: screen.siteId,
      createdBy: before?.createdBy ?? actor.uid,
      createdAt: before?.createdAt ?? at,
      updatedAt: at,
    };
    tx.set(ref, doc);
    const secretRef = db.doc(paths.mqttBrokerSecret(input.orgId, ref.id));
    if (input.password) tx.set(secretRef, { password: input.password } satisfies MqttBrokerSecretDoc);
    else if (input.password === null) tx.delete(secretRef);
    tx.update(screenSnap.ref, { mqttConfigAt: at });
    if (oldBridge && oldBridgeExists) tx.update(db.doc(paths.screen(input.orgId, oldBridge)), { mqttConfigAt: oldStillBridges ? at : null });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: before ? 'mqttBroker.updated' : 'mqttBroker.created',
      // Never the password.
      target: { type: 'mqttBroker', id: ref.id },
      data: { name: input.name, host: input.host, port: input.port, bridgeScreenId: input.bridgeScreenId },
    });
  });
  return { brokerId: ref.id };
}

export async function deleteMqttBroker({ db, now }: Deps, actor: Actor, input: z.infer<typeof MqttBrokerRefInput>): Promise<void> {
  const at = now();
  const ref = db.doc(paths.mqttBroker(input.orgId, input.brokerId));
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const member = await requireOrgPermission(tx, db, actor, input.orgId, 'sensor.manage');
    const broker = (await tx.get(ref)).data() as MqttBrokerDoc | undefined;
    if (!broker) throw new HttpsError('not-found', 'MQTT broker not found.');
    requireSiteInScope(member, broker.siteId, 'this MQTT broker');
    const users = await tx.get(db.collection(paths.sensorDevices(input.orgId)).where('mqttBrokerId', '==', input.brokerId).limit(5));
    if (!users.empty) {
      const names = users.docs.map((d) => `“${(d.data() as SensorDeviceDoc).name}”`).join(', ');
      throw new HttpsError('failed-precondition', `Sensor devices read from this broker: ${names}. Delete them or move them to another broker first.`);
    }
    const stillBridge = await stillBridges(tx, db, input.orgId, broker.bridgeScreenId, input.brokerId);
    const screen = await tx.get(db.doc(paths.screen(input.orgId, broker.bridgeScreenId)));
    tx.delete(ref);
    tx.delete(db.doc(paths.mqttBrokerSecret(input.orgId, input.brokerId)));
    if (screen.exists) tx.update(screen.ref, { mqttConfigAt: stillBridge ? at : null });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'mqttBroker.deleted',
      target: { type: 'mqttBroker', id: input.brokerId },
      data: { name: broker.name },
    });
  });
}

/**
 * Tells the bridge screens of these brokers that their subscriptions changed (sensor device or
 * channel edits). Runs after the edit's own transaction; a failure only delays the bridge until
 * its next configuration refresh.
 */
export async function touchBridges({ db, now }: Deps, orgId: string, brokerIds: Array<string | null | undefined>): Promise<void> {
  const ids = [...new Set(brokerIds.filter((b): b is string => !!b))];
  if (!ids.length) return;
  const brokers = await db.getAll(...ids.map((id) => db.doc(paths.mqttBroker(orgId, id))));
  const screens = new Set(brokers.map((b) => (b.data() as MqttBrokerDoc | undefined)?.bridgeScreenId).filter((s): s is string => !!s));
  await Promise.all([...screens].map((s) => db.doc(paths.screen(orgId, s)).update({ mqttConfigAt: now() }).catch(() => undefined)));
}

/** The authorized device's org and screen, or why not. */
async function bridgeDevice(deps: Deps, req: ApiRequest): Promise<{ orgId: string; screenId: string } | ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  const device = auth as DeviceDoc;
  if (device.status !== 'authorized' || !device.orgId || !device.screenId) return fail(403, 'not_authorized', 'This player is not authorized yet.');
  return { orgId: device.orgId, screenId: device.screenId };
}

/** GET /api/v1/devices/mqtt — brokers this screen bridges, with credentials and subscriptions. */
export async function deviceMqtt(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const who = await bridgeDevice(deps, req);
  if ('status' in who) return who;
  const { db, now } = deps;
  const { orgId, screenId } = who;
  const [orgSnap, entSnap] = await db.getAll(db.doc(paths.org(orgId)), db.doc(paths.orgEntitlements(orgId)));
  const body: DeviceMqttResponse = { brokers: [], serverTime: now() };
  if ((orgSnap!.data() as OrgDoc | undefined)?.status !== 'active' || !mqttEntitled(entSnap!.data() as EntitlementsDoc | undefined)) {
    return { status: 200, body };
  }
  const brokers = (await brokersBridgedBy(db, orgId, screenId).get()).docs.map((d) => d.data() as MqttBrokerDoc);
  for (const b of brokers) {
    const [secret, devices] = await Promise.all([
      b.hasPassword ? db.doc(paths.mqttBrokerSecret(orgId, b.id)).get() : null,
      db.collection(paths.sensorDevices(orgId)).where('mqttBrokerId', '==', b.id).get(),
    ]);
    const subscriptions: DeviceMqttResponse['brokers'][number]['subscriptions'] = [];
    for (const d of devices.docs) {
      const device = d.data() as SensorDeviceDoc;
      if (device.status !== 'active' || device.transport !== 'mqtt') continue;
      const channels = await db.collection(paths.sensorChannels(orgId, device.id)).get();
      for (const c of channels.docs) {
        const ch = c.data() as SensorChannelDoc;
        if (ch.mqtt) subscriptions.push({ topic: ch.mqtt.topic, path: ch.mqtt.path, sensorDeviceId: device.id, channel: ch.id, valueType: ch.valueType });
      }
    }
    body.brokers.push({
      id: b.id,
      host: b.host,
      port: b.port,
      tls: b.tls,
      username: b.username,
      password: (secret?.data() as MqttBrokerSecretDoc | undefined)?.password ?? null,
      clientId: `wxp-${screenId.slice(0, 8)}-${b.id.slice(0, 8)}`,
      subscriptions,
    });
  }
  return { status: 200, body };
}

/** POST /api/v1/devices/mqtt/readings — values the bridge received, per sensor device. */
export async function deviceMqttReadings(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const who = await bridgeDevice(deps, req);
  if ('status' in who) return who;
  const parsed = MqttReadingsBody.safeParse(req.body);
  if (!parsed.success) return fail(400, 'invalid_argument', 'Invalid MQTT readings.');
  const results: MqttReadingsResponse['results'] = [];
  for (const b of parsed.data.batches) {
    const r = await ingestReadings(deps, who.orgId, b.sensorDeviceId, { ts: b.ts, readings: b.readings }, { kind: 'mqtt', screenId: who.screenId });
    const body = r.body as { accepted?: number; error?: string };
    results.push({ sensorDeviceId: b.sensorDeviceId, status: r.status, accepted: body.accepted ?? 0, error: r.status === 200 ? null : (body.error ?? 'error') });
  }
  const response: MqttReadingsResponse = { results, serverTime: deps.now() };
  return { status: 200, body: response };
}

/** Is this screen an MQTT bridge? (Blocks removing it while a broker depends on it.) */
export async function bridgedBrokerNames(tx: Transaction, db: Firestore, orgId: string, screenId: string): Promise<string[]> {
  const snap = await tx.get(brokersBridgedBy(db, orgId, screenId).limit(5));
  return snap.docs.map((d) => (d.data() as MqttBrokerDoc).name);
}

