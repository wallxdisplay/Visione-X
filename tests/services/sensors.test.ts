import { beforeEach, describe, expect, it } from 'vitest';
import { Manifest } from '@wallx-play/layout-spec';
import {
  INGEST_RATE,
  STALE_COVERED_BY_OFFLINE,
  paths,
  readingBucketId,
  type AlertDoc,
  type DeviceHistoryResponse,
  type DeviceLiveResponse,
  type IngestResponse,
  type NotificationDoc,
  type ReadingBucketDoc,
  type SensorChannelDoc,
  type SensorDeviceDoc,
} from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as layouts from '../../functions/src/content/layouts';
import * as schedules from '../../functions/src/content/schedules';
import * as members from '../../functions/src/members/members';
import { runMonitor } from '../../functions/src/ops/monitor';
import { reviewOrgSignup, setOrgStatus } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as screens from '../../functions/src/screens/screens';
import * as sensors from '../../functions/src/sensors/sensors';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const alice = user('alice');
let orgId: string;
let sensorId: string;
let key: string;

const ingest = (body: unknown, authorization = `Bearer ${key}`) =>
  handle(deps, { method: 'POST', path: '/api/v1/ingest', headers: { authorization }, body, ip: '10.0.0.5' });
const channel = async (id: string) =>
  (await db.doc(paths.sensorChannel(orgId, sensorId, id)).get()).data() as SensorChannelDoc;
const device = async () => (await db.doc(paths.sensorDevice(orgId, sensorId)).get()).data() as SensorDeviceDoc;
const alerts = async () =>
  (await db.collection(paths.alerts(orgId)).orderBy('openedAt').get()).docs.map((d) => d.data() as AlertDoc);
const notificationTypes = async () =>
  (await db.collection(paths.notifications(orgId)).orderBy('createdAt').get()).docs.map((d) => (d.data() as NotificationDoc).type);

const tempRule = { id: 'warm', label: 'Too warm', operator: '>' as const, value: 8, severity: 'critical' as const, hysteresis: 0.5 };

async function addChannel(id: string, over: Record<string, unknown> = {}) {
  await sensors.saveSensorChannel(deps, alice, {
    orgId,
    sensorDeviceId: sensorId,
    channelId: id,
    isNew: true,
    name: id === 'temp' ? 'Temperature' : 'Door',
    unit: id === 'temp' ? '°C' : '',
    valueType: id === 'temp' ? 'number' : 'boolean',
    min: id === 'temp' ? -40 : null,
    max: id === 'temp' ? 85 : null,
    staleAfterSec: 600,
    alertRules: id === 'temp' ? [tempRule] : [],
    ...over,
  });
}

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Cold Chain Co',
    contactName: 'Asha',
    phone: '+91 98200 12345',
    city: 'Nashik',
    stateCode: '27',
    expectedScreens: 2,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
  const created = await sensors.saveSensorDevice(deps, alice, {
    orgId,
    name: 'Cold room 1',
    siteId: null,
    offlineAfterMin: 15,
    enabled: true,
  });
  sensorId = created.sensorDeviceId;
  key = created.apiKey!;
  await addChannel('temp');
  await addChannel('door');
});

describe('sensor devices', () => {
  it('issues a key once and stores only its hash', async () => {
    expect(key).toMatch(/^wxp_[A-Za-z0-9_-]{32}$/);
    const d = await device();
    expect(d.keyPrefix).toBe(key.slice(0, 10));
    expect(JSON.stringify(d)).not.toContain(key);
    expect(d.channelCount).toBe(2);
  });

  it('enforces the plan limit and the sensor.manage permission', async () => {
    const input = { orgId, name: 'Freezer', siteId: null, offlineAfterMin: 15, enabled: true };
    await sensors.saveSensorDevice(deps, alice, input); // trial allows 2
    await expectCode(sensors.saveSensorDevice(deps, alice, input), 'resource-exhausted');
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'ed@example.com', role: 'editor' });
    await members.acceptInvite(deps, user('ed'), { token });
    await expectCode(sensors.saveSensorChannel(deps, user('ed'), {
      orgId, sensorDeviceId: sensorId, channelId: 'hum', isNew: true, name: 'Humidity', unit: '%',
      valueType: 'number', min: 0, max: 100, staleAfterSec: 600, alertRules: [],
    }), 'permission-denied');
  });

  it('rotating the key retires the old one; deleting removes keys and data', async () => {
    expect((await ingest({ readings: [{ channel: 'temp', value: 4 }] })).status).toBe(200);
    const { apiKey } = await sensors.rotateSensorKey(deps, alice, { orgId, sensorDeviceId: sensorId });
    expect((await ingest({ readings: [{ channel: 'temp', value: 4 }] })).status).toBe(401);
    expect((await ingest({ readings: [{ channel: 'temp', value: 4 }] }, `Bearer ${apiKey}`)).status).toBe(200);

    await sensors.deleteSensorDevice(deps, alice, { orgId, sensorDeviceId: sensorId });
    expect((await ingest({ readings: [{ channel: 'temp', value: 4 }] }, `Bearer ${apiKey}`)).status).toBe(401);
    expect((await db.collection(paths.sensorChannels(orgId, sensorId)).get()).empty).toBe(true);
    expect((await db.collection(paths.sensorKeys()).get()).empty).toBe(true);
  });
});

describe('ingest', () => {
  it('stores accepted readings and reports rejected ones', async () => {
    const res = await ingest({ fw: 'wxp-esp32 1.0.0', readings: [
      { channel: 'temp', value: 4.25 },
      { channel: 'door', value: false },
      { channel: 'humidity', value: 40 },
    ] });
    expect(res.status).toBe(200);
    const body = res.body as IngestResponse;
    expect(body.accepted).toBe(2);
    expect(body.rejected).toEqual([{ channel: 'humidity', reason: 'unknown_channel' }]);

    const now = deps.now();
    expect((await channel('temp')).latest).toEqual({ value: 4.25, ts: now });
    expect((await channel('door')).latest).toEqual({ value: 0, ts: now });
    const bucket = (await db.doc(paths.sensorReading(orgId, sensorId, 'temp', readingBucketId(now))).get()).data() as ReadingBucketDoc;
    expect(bucket.points).toEqual([{ t: now, v: 4.25 }]);
    const d = await device();
    expect(d.lastSeen).toBe(now);
    expect(d.firmware).toBe('wxp-esp32 1.0.0');
  });

  it('rejects bad credentials, payloads, ranges and clocks', async () => {
    expect((await ingest({ readings: [{ channel: 'temp', value: 4 }] }, '')).status).toBe(401);
    expect((await ingest({ readings: [{ channel: 'temp', value: 4 }] }, `Bearer wxp_${'x'.repeat(32)}`)).status).toBe(401);
    expect((await ingest({ readings: 'nope' })).status).toBe(400);
    expect((await ingest({ deviceId: 'someoneElse', readings: [{ channel: 'temp', value: 4 }] })).status).toBe(400);
    const out = await ingest({ readings: [{ channel: 'temp', value: 500 }, { channel: 'door', value: 3 }] });
    expect(out.status).toBe(422);
    expect((out.body as IngestResponse).rejected.map((r) => r.reason)).toEqual(['out_of_range', 'wrong_type']);
    const skewed = await ingest({ ts: Math.floor(deps.now() / 1000) - 3600, readings: [{ channel: 'temp', value: 4 }] });
    expect(skewed.status).toBe(400);
    expect((skewed.body as { error: string }).error).toBe('clock_skew');
    expect((await ingest({ ts: Math.floor(deps.now() / 1000) - 60, readings: [{ channel: 'temp', value: 4 }] })).status).toBe(200);
  });

  it('refuses disabled devices, inactive orgs and plans without sensors', async () => {
    await sensors.saveSensorDevice(deps, alice, { orgId, sensorDeviceId: sensorId, name: 'Cold room 1', siteId: null, offlineAfterMin: 15, enabled: false });
    expect((await ingest({ readings: [{ channel: 'temp', value: 4 }] })).status).toBe(403);
    await sensors.saveSensorDevice(deps, alice, { orgId, sensorDeviceId: sensorId, name: 'Cold room 1', siteId: null, offlineAfterMin: 15, enabled: true });
    expect((await ingest({ readings: [{ channel: 'temp', value: 4 }] })).status).toBe(200);

    await db.doc(paths.orgEntitlements(orgId)).update({ features: ['media.basic'] });
    expect(((await ingest({ readings: [{ channel: 'temp', value: 4 }] })).body as { error: string }).error).toBe('not_entitled');

    await setOrgStatus(deps, superadmin, { orgId, action: 'suspend', reason: 'Payment overdue' });
    expect(((await ingest({ readings: [{ channel: 'temp', value: 4 }] })).body as { error: string }).error).toBe('org_inactive');
  });

  it('rate-limits each device with a token bucket', async () => {
    for (let i = 0; i < INGEST_RATE.capacity; i++) {
      expect((await ingest({ readings: [{ channel: 'temp', value: i }] })).status).toBe(200);
    }
    const limited = await ingest({ readings: [{ channel: 'temp', value: 9 }] });
    expect(limited.status).toBe(429);
    advance(INGEST_RATE.refillMs);
    expect((await ingest({ readings: [{ channel: 'temp', value: 9 }] })).status).toBe(200);
  });
});

describe('alerts', () => {
  it('opens on breach, holds within hysteresis, recovers once clearly back', async () => {
    await ingest({ readings: [{ channel: 'temp', value: 9.2 }] });
    let [alert] = await alerts();
    expect(alert).toMatchObject({ type: 'threshold', status: 'open', severity: 'critical', ruleLabel: 'Too warm', value: 9.2 });
    expect((await channel('temp')).openAlerts).toEqual({ warm: alert!.id });

    advance(10_000);
    await ingest({ readings: [{ channel: 'temp', value: 7.8 }] });
    [alert] = await alerts();
    expect(alert).toMatchObject({ status: 'open', lastValue: 7.8 });

    advance(10_000);
    await ingest({ readings: [{ channel: 'temp', value: 7.2 }] });
    [alert] = await alerts();
    expect(alert!.status).toBe('resolved');
    expect((await channel('temp')).openAlerts).toEqual({});
    expect(await notificationTypes()).toEqual(['sensor_alert', 'sensor_recovered']);

    await sensors.acknowledgeAlert(deps, alice, { orgId, alertId: alert!.id });
    expect((await alerts())[0]!.acknowledgedBy).toBe('alice');
  });

  it('raises stale while the device reports, offline when it goes silent, and clears both', async () => {
    await ingest({ readings: [{ channel: 'temp', value: 4 }, { channel: 'door', value: false }] });
    advance(9 * 60_000);
    await ingest({ readings: [{ channel: 'door', value: true }] }); // temp goes quiet
    advance(2 * 60_000);
    expect(await runMonitor(deps)).toMatchObject({ sensorsOffline: 0, channelsStale: 1 });
    expect((await alerts()).map((a) => [a.type, a.channelId])).toEqual([['stale', 'temp']]);
    expect(await runMonitor(deps)).toMatchObject({ channelsStale: 0 }); // raised once

    advance(20 * 60_000);
    expect(await runMonitor(deps)).toMatchObject({ sensorsOffline: 1, channelsStale: 0 });
    expect((await channel('door')).staleAlertId).toBe(STALE_COVERED_BY_OFFLINE);

    advance(30_000);
    await ingest({ readings: [{ channel: 'temp', value: 4.1 }] });
    expect((await alerts()).every((a) => a.status === 'resolved')).toBe(true);
    expect((await channel('door')).staleAlertId).toBeNull();
    expect((await device()).offlineAlertId).toBeNull();
    const types = await notificationTypes();
    expect(types.slice(0, 2)).toEqual(['sensor_stale', 'sensor_offline']);
    expect(types.slice(2).sort()).toEqual(['sensor_online', 'sensor_recovered']); // same instant
  });
});

describe('sensor widgets on screens', () => {
  it('publishes bound channels and serves live values and history to the player', async () => {
    // A player paired to the org.
    const reg = await handle(deps, {
      method: 'POST', path: '/api/v1/devices/register', headers: {}, ip: '10.0.0.9',
      body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '11', sdkInt: 30, appVersion: '0.5.0', display: { width: 1920, height: 1080 } } },
    });
    const b = reg.body as { deviceId: string; deviceSecret: string; pairingCode: string };
    const playerAuth = `Device ${b.deviceId}:${b.deviceSecret}`;
    const player = (path: string) => handle(deps, { method: 'GET', path, headers: { authorization: playerAuth }, body: {}, ip: '10.0.0.9' });
    await screens.claimDevice(deps, alice, {
      orgId, pairingCode: b.pairingCode, name: 'Store', siteId: null, groupIds: [], orientation: 'landscape', resolution: { width: 1920, height: 1080 },
    });

    const binding = { source: 'sensor' as const, sourceId: sensorId, field: 'temp' };
    const zone = (id: string, x: number, widget: unknown) => ({ id, name: id, x, y: 0, w: 0.5, h: 1, z: 0, content: { kind: 'widget', widget } });
    const layout = {
      name: 'Cold room board',
      canvas: { width: 1920, height: 1080, orientation: 'landscape' as const, background: '#000000' },
      zones: [
        zone('v', 0, { type: 'sensorValue', binding, label: 'Cold room', unit: '°C', thresholds: [], style: {} }),
        zone('c', 0.5, { type: 'chart', bindings: [binding], label: '', kind: 'line', windowMinutes: 60, style: {} }),
      ],
    } as Parameters<typeof layouts.saveLayout>[2]['layout'];

    await expectCode(
      layouts.saveLayout(deps, alice, { orgId, layout: { ...layout, zones: [zone('v', 0, { type: 'sensorValue', binding: { ...binding, field: 'nope' }, unit: '', thresholds: [], style: {} })] } as typeof layout }),
      'invalid-argument',
    );
    const { layoutId } = await layouts.saveLayout(deps, alice, { orgId, layout });
    const { playlistId } = await layouts.savePlaylist(deps, alice, {
      orgId, name: 'Board', items: [{ id: 'i', content: { kind: 'layout', layoutId }, durationSec: 30, transition: 'none' }],
    });
    await schedules.saveSchedule(deps, alice, {
      orgId, name: 'Always', playlistId, target: { kind: 'all' }, priority: 10, timezone: 'Asia/Kolkata',
      startDate: null, endDate: null, daysOfWeek: [], windowStart: null, windowEnd: null, enabled: true,
    });
    await screens.publishScreens(deps, alice, { orgId, screenIds: [] });

    const manifest = Manifest.parse((await player('/api/v1/devices/manifest')).body);
    expect(manifest.liveChannels).toEqual([{ sourceId: sensorId, field: 'temp', historyMinutes: 60 }]);

    await ingest({ readings: [{ channel: 'temp', value: 3.5 }] });
    advance(60_000);
    await ingest({ readings: [{ channel: 'temp', value: 3.9 }] });

    const live = (await player('/api/v1/devices/live')).body as DeviceLiveResponse;
    expect(live.values).toEqual([
      { sourceId: sensorId, field: 'temp', name: 'Temperature', value: 3.9, ts: deps.now(), staleAfterSec: 600, deviceOnline: true, unit: '°C', valueType: 'number' },
    ]);
    const history = (await player('/api/v1/devices/live/history')).body as DeviceHistoryResponse;
    expect(history.series[0]!.points.map(([, v]) => v)).toEqual([3.5, 3.9]);

    // In use: the channel and the device cannot be deleted.
    await expectCode(sensors.deleteSensorChannel(deps, alice, { orgId, sensorDeviceId: sensorId, channelId: 'temp' }), 'failed-precondition');
    await expectCode(sensors.deleteSensorDevice(deps, alice, { orgId, sensorDeviceId: sensorId }), 'failed-precondition');
    await sensors.deleteSensorChannel(deps, alice, { orgId, sensorDeviceId: sensorId, channelId: 'door' });
    expect((await device()).channelCount).toBe(1);
  });

  it('treats sensor values in table cells like sensor widgets', async () => {
    const cell = { source: 'sensor' as const, sourceId: sensorId, field: 'temp' };
    const table = (c: typeof cell) => ({ type: 'table', columns: ['Room', 'Temp'], rows: [{ cells: ['Cold room', c] }], style: {} });
    const playlist = (c: typeof cell) => ({
      orgId, name: 'Temps', items: [{ id: 't', content: { kind: 'widget', widget: table(c) }, durationSec: 15, transition: 'none' }],
    }) as Parameters<typeof layouts.savePlaylist>[2];

    await expectCode(layouts.savePlaylist(deps, alice, playlist({ ...cell, field: 'nope' })), 'invalid-argument');
    await layouts.savePlaylist(deps, alice, playlist(cell));
    // In use by the playlist's table: the channel cannot be deleted.
    await expectCode(sensors.deleteSensorChannel(deps, alice, { orgId, sensorDeviceId: sensorId, channelId: 'temp' }), 'failed-precondition');

    // Without sensors in the plan, a table may not show sensor values (plain tables still work).
    await db.doc(paths.orgEntitlements(orgId)).update({ features: ['media.basic', 'widget.core'] });
    await expectCode(layouts.savePlaylist(deps, alice, playlist(cell)), 'permission-denied');
    await layouts.savePlaylist(deps, alice, { ...playlist(cell), items: [{ id: 't', content: { kind: 'widget', widget: { type: 'table', columns: ['A'], rows: [{ cells: ['1'] }], style: {} } }, durationSec: 15, transition: 'none' }] } as Parameters<typeof layouts.savePlaylist>[2]);
  });
});
