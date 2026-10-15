import { beforeEach, describe, expect, it } from 'vitest';
import {
  paths,
  type DeviceMqttResponse,
  type DeviceStateResponse,
  type MqttBrokerDoc,
  type MqttReadingsResponse,
  type ScreenDoc,
  type SensorChannelDoc,
  type SensorDeviceDoc,
} from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as screens from '../../functions/src/screens/screens';
import * as mqtt from '../../functions/src/sensors/mqtt';
import * as sensors from '../../functions/src/sensors/sensors';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
let orgId: string;

const api = (method: string, path: string, auth: string, body: unknown = {}) => handle(deps, { method, path, headers: { authorization: auth }, body, ip: '10.0.0.9' });

async function pair(name: string) {
  const reg = await handle(deps, {
    method: 'POST',
    path: '/api/v1/devices/register',
    headers: {},
    ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '12', sdkInt: 31, appVersion: '0.18.0', display: { width: 1920, height: 1080 } } },
  });
  const b = reg.body as { deviceId: string; deviceSecret: string; pairingCode: string };
  const { screenId } = await screens.claimDevice(deps, alice, {
    orgId,
    pairingCode: b.pairingCode,
    name,
    siteId: null,
    groupIds: [],
    orientation: 'landscape',
    resolution: { width: 1920, height: 1080 },
  });
  return { screenId, auth: `Device ${b.deviceId}:${b.deviceSecret}` };
}

const setFeatures = async (add: string[]) => {
  const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
  await db.doc(paths.orgEntitlements(orgId)).update({ features: [...new Set([...(ent.features as string[]), ...add])], 'limits.screens': 10 });
};

const brokerInput = (bridgeScreenId: string, over: Record<string, unknown> = {}) => ({
  orgId,
  name: 'Plant broker',
  host: '192.168.1.20',
  port: 1883,
  tls: false,
  username: 'wallx',
  password: 'broker-pass-1',
  bridgeScreenId,
  ...over,
});

async function mqttDevice(brokerId: string) {
  const { sensorDeviceId } = await sensors.saveSensorDevice(deps, alice, {
    orgId,
    name: 'Line 1',
    siteId: null,
    offlineAfterMin: 15,
    enabled: true,
    transport: 'mqtt',
    mqttBrokerId: brokerId,
  });
  await sensors.saveSensorChannel(deps, alice, {
    orgId,
    sensorDeviceId,
    channelId: 'temp',
    isNew: true,
    name: 'Temperature',
    unit: '°C',
    valueType: 'number',
    min: -40,
    max: 125,
    staleAfterSec: 600,
    alertRules: [{ id: 'hot', label: 'Too hot', operator: '>', value: 80, severity: 'critical', hysteresis: 0 }],
    mqtt: { topic: 'plant/line1', path: 'temp' },
  });
  return sensorDeviceId;
}

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Plant Co',
    contactName: 'Asha',
    phone: '+91 98200 12345',
    city: 'Pune',
    stateCode: '27',
    expectedScreens: 2,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

describe('MQTT sensors', () => {
  it('a broker is bridged by a screen, which gets the credentials and subscriptions', async () => {
    const bridge = await pair('Plant lobby');
    const other = await pair('Canteen');
    await expectCode(mqtt.saveMqttBroker(deps, alice, brokerInput(bridge.screenId)), 'permission-denied');
    await setFeatures(['sensor.esp32', 'sensor.mqtt']);
    const { brokerId } = await mqtt.saveMqttBroker(deps, alice, brokerInput(bridge.screenId));

    // The password is server-only.
    const doc = (await db.doc(paths.mqttBroker(orgId, brokerId)).get()).data() as MqttBrokerDoc;
    expect(doc).toMatchObject({ host: '192.168.1.20', hasPassword: true, bridgeScreenId: bridge.screenId });
    expect(JSON.stringify(doc)).not.toContain('broker-pass-1');

    const sensorDeviceId = await mqttDevice(brokerId);
    const device = (await db.doc(paths.sensorDevice(orgId, sensorDeviceId)).get()).data() as SensorDeviceDoc;
    expect(device).toMatchObject({ transport: 'mqtt', mqttBrokerId: brokerId, keyPrefix: '' });
    await expectCode(sensors.rotateSensorKey(deps, alice, { orgId, sensorDeviceId }), 'failed-precondition');
    await expectCode(
      sensors.saveSensorChannel(deps, alice, {
        orgId, sensorDeviceId, channelId: 'hum', isNew: true, name: 'Humidity', unit: '%', valueType: 'number',
        min: null, max: null, staleAfterSec: 600, alertRules: [], mqtt: null,
      }),
      'invalid-argument',
    );

    const me = (await api('GET', '/api/v1/devices/me', bridge.auth)).body as DeviceStateResponse;
    expect(me.mqttConfigAt).toEqual(expect.any(Number));
    expect(((await api('GET', '/api/v1/devices/me', other.auth)).body as DeviceStateResponse).mqttConfigAt).toBeNull();

    const config = (await api('GET', '/api/v1/devices/mqtt', bridge.auth)).body as DeviceMqttResponse;
    expect(config.brokers).toHaveLength(1);
    expect(config.brokers[0]).toMatchObject({ host: '192.168.1.20', port: 1883, username: 'wallx', password: 'broker-pass-1' });
    expect(config.brokers[0]!.subscriptions).toEqual([{ topic: 'plant/line1', path: 'temp', sensorDeviceId, channel: 'temp', valueType: 'number' }]);
    expect(((await api('GET', '/api/v1/devices/mqtt', other.auth)).body as DeviceMqttResponse).brokers).toEqual([]);

    // Keeping the password when it is not sent; removing it with null.
    await mqtt.saveMqttBroker(deps, alice, { ...brokerInput(bridge.screenId), brokerId, password: undefined, port: 8883, tls: true });
    expect(((await api('GET', '/api/v1/devices/mqtt', bridge.auth)).body as DeviceMqttResponse).brokers[0]).toMatchObject({ port: 8883, tls: true, password: 'broker-pass-1' });
    await mqtt.saveMqttBroker(deps, alice, { ...brokerInput(bridge.screenId), brokerId, password: null });
    expect(((await api('GET', '/api/v1/devices/mqtt', bridge.auth)).body as DeviceMqttResponse).brokers[0]!.password).toBeNull();
  });

  it('the bridge forwards readings through the ingest core; nobody else can', async () => {
    const bridge = await pair('Plant lobby');
    const other = await pair('Canteen');
    await setFeatures(['sensor.esp32', 'sensor.mqtt']);
    const { brokerId } = await mqtt.saveMqttBroker(deps, alice, brokerInput(bridge.screenId));
    const sensorDeviceId = await mqttDevice(brokerId);
    const { sensorDeviceId: httpId } = await sensors.saveSensorDevice(deps, alice, { orgId, name: 'ESP32', siteId: null, offlineAfterMin: 15, enabled: true });

    const send = (auth: string, id: string, value: number) =>
      api('POST', '/api/v1/devices/mqtt/readings', auth, { batches: [{ sensorDeviceId: id, ts: deps.now(), readings: [{ channel: 'temp', value }] }] });

    const ok = (await send(bridge.auth, sensorDeviceId, 85)).body as MqttReadingsResponse;
    expect(ok.results).toEqual([{ sensorDeviceId, status: 200, accepted: 1, error: null }]);
    const ch = (await db.doc(paths.sensorChannel(orgId, sensorDeviceId, 'temp')).get()).data() as SensorChannelDoc;
    expect(ch.latest?.value).toBe(85);
    expect(Object.keys(ch.openAlerts)).toEqual(['hot']); // alert rules run as for ESP32
    expect(((await db.doc(paths.sensorDevice(orgId, sensorDeviceId)).get()).data() as SensorDeviceDoc).lastSeen).toBe(deps.now());

    advance(15_000);
    expect(((await send(other.auth, sensorDeviceId, 20)).body as MqttReadingsResponse).results[0]!.error).toBe('not_bridge');
    expect(((await send(bridge.auth, httpId, 20)).body as MqttReadingsResponse).results[0]!.error).toBe('not_mqtt');

    // Without the plan feature the bridge gets no configuration and readings are refused.
    const ent = (await db.doc(paths.orgEntitlements(orgId)).get()).data()!;
    await db.doc(paths.orgEntitlements(orgId)).update({ features: (ent.features as string[]).filter((f) => f !== 'sensor.mqtt') });
    expect(((await api('GET', '/api/v1/devices/mqtt', bridge.auth)).body as DeviceMqttResponse).brokers).toEqual([]);
    expect(((await send(bridge.auth, sensorDeviceId, 20)).body as MqttReadingsResponse).results[0]!.error).toBe('not_entitled');
  });

  it('brokers in use and bridge screens are protected; moving the bridge updates both screens', async () => {
    const bridge = await pair('Plant lobby');
    const next = await pair('Office');
    await setFeatures(['sensor.esp32', 'sensor.mqtt']);
    const { brokerId } = await mqtt.saveMqttBroker(deps, alice, brokerInput(bridge.screenId));
    const sensorDeviceId = await mqttDevice(brokerId);

    await expectCode(mqtt.deleteMqttBroker(deps, alice, { orgId, brokerId }), 'failed-precondition');
    await expectCode(screens.removeScreen(deps, alice, { orgId, screenId: bridge.screenId }), 'failed-precondition');

    await mqtt.saveMqttBroker(deps, alice, { ...brokerInput(next.screenId), brokerId, password: undefined });
    const screen = async (id: string) => ((await db.doc(paths.screen(orgId, id)).get()).data() as ScreenDoc).mqttConfigAt;
    expect(await screen(bridge.screenId)).toBeNull();
    expect(await screen(next.screenId)).toEqual(expect.any(Number));
    expect(((await api('GET', '/api/v1/devices/mqtt', next.auth)).body as DeviceMqttResponse).brokers[0]!.password).toBe('broker-pass-1');

    // Channel edits tell the bridge to refresh.
    const before = await screen(next.screenId);
    advance(5_000);
    await sensors.deleteSensorChannel(deps, alice, { orgId, sensorDeviceId, channelId: 'temp' });
    expect(await screen(next.screenId)).toBeGreaterThan(before!);

    await sensors.deleteSensorDevice(deps, alice, { orgId, sensorDeviceId });
    await mqtt.deleteMqttBroker(deps, alice, { orgId, brokerId });
    expect(await screen(next.screenId)).toBeNull();
    expect((await db.doc(paths.mqttBrokerSecret(orgId, brokerId)).get()).exists).toBe(false);
  });
});
