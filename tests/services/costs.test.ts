import { beforeEach, describe, expect, it } from 'vitest';
import { paths, usageKey, type CostUsageDoc, type ScreenDoc, type SensorDeviceDoc } from '@wallx-play/shared';
import { handle } from '../../functions/src/api/router';
import * as billing from '../../functions/src/billing/billing';
import { costReport, runCostRollup, saveCostRates } from '../../functions/src/costs/report';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as screens from '../../functions/src/screens/screens';
import * as sensors from '../../functions/src/sensors/sensors';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const DAY = 86_400_000;
const alice = user('alice');
const billingStaff = user('bill', { platformRole: 'billing' });
let orgId: string;
let screenId: string;
let deviceAuth: string;
let sensorId: string;
let sensorKey: string;

const api = (path: string, body: unknown, authorization: string) => handle(deps, { method: 'POST', path, headers: { authorization }, body, ip: '10.0.0.1' });
const heartbeat = () =>
  api('/api/v1/devices/heartbeat', { appVersion: '0.19.0', display: { width: 1920, height: 1080 }, storageFreeMb: 4096, playing: null, manifestVersion: 0, errors: [] }, deviceAuth);
const ingest = (n: number) => api('/api/v1/ingest', { readings: Array.from({ length: n }, (_, i) => ({ channel: i === 0 ? 'temp' : 'hum', value: 5 })) }, `Bearer ${sensorKey}`);

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Acme', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
  const reg = await handle(deps, {
    method: 'POST', path: '/api/v1/devices/register', headers: {}, ip: '10.0.0.9',
    body: { hardware: { manufacturer: 'X', model: 'Box', androidVersion: '12', sdkInt: 31, appVersion: '0.19.0', display: { width: 1920, height: 1080 } } },
  });
  const b = reg.body as { deviceId: string; deviceSecret: string; pairingCode: string };
  deviceAuth = `Device ${b.deviceId}:${b.deviceSecret}`;
  screenId = (await screens.claimDevice(deps, alice, { orgId, pairingCode: b.pairingCode, name: 'Lobby', siteId: null, groupIds: [], orientation: 'landscape', resolution: { width: 1920, height: 1080 } })).screenId;
  const created = await sensors.saveSensorDevice(deps, alice, { orgId, name: 'Cold room', siteId: null, offlineAfterMin: 15, enabled: true });
  sensorId = created.sensorDeviceId;
  sensorKey = created.apiKey!;
  for (const c of ['temp', 'hum']) {
    await sensors.saveSensorChannel(deps, alice, { orgId, sensorDeviceId: sensorId, channelId: c, isNew: true, name: c, unit: '', valueType: 'number', min: null, max: null, staleAfterSec: 600, alertRules: [] });
  }
});

describe('cost tracking', () => {
  it('counts heartbeats and sensor readings in the writes that happen anyway, and drops old days', async () => {
    const day1 = usageKey(deps.now());
    await heartbeat();
    await heartbeat();
    expect(((await db.doc(paths.screen(orgId, screenId)).get()).data() as ScreenDoc).usage?.[day1]).toEqual({ beats: 2 });

    expect((await ingest(2)).status).toBe(200);
    advance(11_000); // the ingest rate limit
    expect((await ingest(1)).status).toBe(200);
    expect(((await db.doc(paths.sensorDevice(orgId, sensorId)).get()).data() as SensorDeviceDoc).usage?.[day1]).toEqual({ requests: 2, readings: 3 });

    advance(9 * DAY);
    await heartbeat();
    const usage = ((await db.doc(paths.screen(orgId, screenId)).get()).data() as ScreenDoc).usage!;
    expect(Object.keys(usage)).toEqual([usageKey(deps.now())]); // the old day is gone
  });

  it('rolls days up once and reports revenue against cost per organization and per app', async () => {
    // One paid month on app pricing: 2 screens + Weather on 1 + 1 sensor device.
    await billing.updateSubscription(deps, billingStaff, { orgId, planId: 'starter', interval: 'monthly', quantity: 2, customPriceMinor: null, discountBps: 0, pricing: 'apps', apps: [{ appId: 'weather', quantity: 1 }, { appId: 'sensors', quantity: 1 }], repriceApps: false, reason: 'Paying customer' });
    await billing.recordPayment(deps, billingStaff, { orgId, amountMinor: 1, method: 'upi', reference: 'UTR-1', paidAt: deps.now(), periods: 1 });
    for (let i = 0; i < 3; i++) await heartbeat();
    const ds = db.collection(paths.dataSources(orgId)).doc('pune');
    await ds.set({ id: 'pune', name: 'Pune', type: 'weather', config: {}, createdBy: 'alice', createdAt: 0, updatedAt: 0, lastFetch: null, usage: { [usageKey(deps.now())]: { calls: 2_000 } } });
    const dayId = new Date(deps.now()).toISOString().slice(0, 10);

    advance(DAY);
    expect((await runCostRollup(deps)).days).toBeGreaterThanOrEqual(1);
    const rolled = (await db.doc(paths.costUsageDay(orgId, dayId)).get()).data() as CostUsageDoc;
    expect(rolled).toMatchObject({ screens: 1, heartbeats: 3, weatherCalls: 2_000 });
    expect((await runCostRollup(deps)).days).toBe(0); // already rolled up

    await expectCode(costReport(deps, alice, { month: dayId.slice(0, 7) }), 'permission-denied');
    await expectCode(saveCostRates(deps, user('aud', { platformRole: 'auditor' }), { per1000Heartbeats: 1, perGbDelivered: 1, perGbMonthStored: 1, per1000WeatherCalls: 1, per1000AirQualityCalls: 1, per1000SensorRequests: 1, per1000ApiCalls: 1, per1000Emails: 0, perOrgMonth: 0 }), 'permission-denied');
    const report = await costReport(deps, billingStaff, { month: dayId.slice(0, 7) });
    const row = report.rows.find((r) => r.orgId === orgId)!;
    expect(row.revenueMinor).toBe(2 * 29_900 + 4_900 + 14_900);
    expect(row.revenueByApp).toEqual({ screen: 59_800, weather: 4_900, sensors: 14_900 });
    expect(row.cost.weather).toBe(1_056); // 2,000 calls at ₹5.28 per 1,000
    expect(report.byApp.find((a) => a.appId === 'weather')).toMatchObject({ revenueMinor: 4_900, costMinor: 1_056 });

    // Staff change a unit cost: the report follows.
    await saveCostRates(deps, superadmin, { ...report.rates, per1000WeatherCalls: 1_000 });
    expect((await costReport(deps, billingStaff, { month: dayId.slice(0, 7) })).rows.find((r) => r.orgId === orgId)!.cost.weather).toBe(2_000);
  });
});
