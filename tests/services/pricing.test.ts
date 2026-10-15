import { beforeEach, describe, expect, it } from 'vitest';
import { paths, type EntitlementsDoc, type SubscriptionDoc } from '@wallx-play/shared';
import * as catalog from '../../functions/src/apps/catalog';
import * as billing from '../../functions/src/billing/billing';
import { runMonitor } from '../../functions/src/ops/monitor';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import * as sensors from '../../functions/src/sensors/sensors';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const DAY = 86_400_000;
const alice = user('alice');
const billingStaff = user('bill', { platformRole: 'billing' });
let orgId: string;

const sub = async () => (await db.doc(paths.orgSubscription(orgId)).get()).data() as SubscriptionDoc;
const ent = async () => (await db.doc(paths.orgEntitlements(orgId)).get()).data() as EntitlementsDoc;
const setApps = (apps: Array<{ appId: string; quantity: number }>, over: Record<string, unknown> = {}) =>
  billing.updateSubscription(deps, billingStaff, { orgId, planId: 'starter', interval: 'monthly', quantity: 3, customPriceMinor: null, discountBps: 0, apps, reason: 'Customer chose apps', ...over });

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Acme',
    contactName: 'Asha',
    phone: '+91 98200 12345',
    city: 'Pune',
    stateCode: '27',
    expectedScreens: 3,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

describe('app pricing', () => {
  it('new organizations try every released app; after the trial only the apps bought remain', async () => {
    expect(await sub()).toMatchObject({ pricing: 'apps', apps: [], status: 'trialing' });
    const trial = (await ent()).features;
    expect(trial).toEqual(expect.arrayContaining(['media.basic', 'widget.weather', 'widget.rss', 'content.approvals', 'sensor.esp32']));
    expect(trial).not.toContain('interactive.touch'); // not released yet (planned)

    advance(15 * DAY);
    await runMonitor(deps);
    expect((await sub()).status).toBe('restricted');
    const after = (await ent()).features;
    expect(after).toContain('media.basic');
    expect(after).not.toContain('widget.weather');
    expect(after).not.toContain('content.approvals');
  });

  it('bill lines: base screens plus apps at locked prices', async () => {
    await setApps([{ appId: 'weather', quantity: 2 }, { appId: 'approvals', quantity: 1 }]);
    await billing.recordPayment(deps, billingStaff, { orgId, amountMinor: 1, method: 'upi', reference: 'UTR-1', paidAt: deps.now(), periods: 1 });
    const s = await sub();
    // Screens 3 × ₹299 + Weather 2 × ₹49 + Approvals ₹499 = ₹1,494
    expect(s.amountPerPeriodMinor).toBe(149_400);
    expect(s.apps?.map((l) => [l.appId, l.quantity, l.unitPriceMinor])).toEqual([['weather', 2, 4_900], ['approvals', 1, 49_900]]);
    const features = (await ent()).features;
    expect(features).toEqual(expect.arrayContaining(['widget.weather', 'content.approvals']));
    expect(features).not.toContain('widget.rss');

    // A catalog price change does not reprice existing customers until staff do it.
    await catalog.saveApp(deps, billingStaff, {
      id: 'weather', isNew: false, name: 'Weather & air quality', description: '', unit: 'screen', featureKeys: ['widget.weather'], requires: [], base: false,
      storageGBPerUnit: null, priceMinor: 7_900, dealerPriceMinor: null, costMinor: 2_784, costNote: '', active: true, sortOrder: 10, reason: 'AQI costs more',
    });
    await setApps([{ appId: 'weather', quantity: 3 }, { appId: 'approvals', quantity: 1 }]);
    expect((await sub()).apps?.[0]).toMatchObject({ quantity: 3, unitPriceMinor: 4_900 });
    await setApps([{ appId: 'weather', quantity: 3 }, { appId: 'approvals', quantity: 1 }], { repriceApps: true });
    expect((await sub()).apps?.[0]).toMatchObject({ unitPriceMinor: 7_900 });
    // ₹897 + 3 × ₹79 + ₹499 = ₹1,633
    expect((await sub()).amountPerPeriodMinor).toBe(163_300);
  });

  it('refuses lines that do not fit, and turns storage packs and sensors into limits', async () => {
    await expectCode(setApps([{ appId: 'weather', quantity: 4 }]), 'invalid-argument'); // more than the 3 screens
    await expectCode(setApps([{ appId: 'mqtt', quantity: 1 }]), 'invalid-argument'); // needs Sensors
    await expectCode(setApps([{ appId: 'approvals', quantity: 2 }]), 'invalid-argument'); // once per organization
    await expectCode(setApps([{ appId: 'screen', quantity: 1 }]), 'invalid-argument'); // base is included

    await setApps([{ appId: 'sensors', quantity: 1 }, { appId: 'storage', quantity: 2 }]);
    const limits = (await ent()).limits;
    expect(limits.sensorDevices).toBe(1);
    const starter = (await db.doc(paths.plan('starter')).get()).data()!;
    expect(limits.storageGB).toBe((starter.limits.storageGB as number) + 20);

    await sensors.saveSensorDevice(deps, alice, { orgId, name: 'Cold room', siteId: null, offlineAfterMin: 15, enabled: true });
    await expectCode(sensors.saveSensorDevice(deps, alice, { orgId, name: 'Second', siteId: null, offlineAfterMin: 15, enabled: true }), 'resource-exhausted');
    await expectCode(setApps([{ appId: 'storage', quantity: 2 }]), 'failed-precondition'); // a sensor device is in use
  });

  it('moves a plan-priced customer to app pricing at the same price (grandfathered)', async () => {
    await billing.updateSubscription(deps, billingStaff, { orgId, planId: 'professional', interval: 'monthly', quantity: 4, customPriceMinor: null, discountBps: 0, pricing: 'plan', reason: 'Professional deal' });
    await billing.recordPayment(deps, billingStaff, { orgId, amountMinor: 1, method: 'upi', reference: 'UTR-1', paidAt: deps.now(), periods: 1 });
    const before = await sub();
    expect(before.amountPerPeriodMinor).toBe(4 * 59_900);
    const featuresBefore = (await ent()).features;

    const preview = await billing.moveToAppPricing(deps, billingStaff, { orgId, apply: false });
    expect(preview.applied).toBe(false);
    expect(preview.oldMonthlyMinor).toBe(4 * 59_900);
    // Professional's features as apps: weather, news, proof-of-play, diagnostics on 4 screens, approvals once (no sensors in use).
    expect(preview.lines.map((l) => l.name)).toEqual(['Screen', 'Weather & air quality', 'News (RSS)', 'Proof-of-play', 'Analytics & diagnostics', 'Content approvals', 'Adjustment']);
    expect(preview.newMonthlyMinor + preview.adjustmentMinor).toBe(4 * 59_900);
    expect((await sub()).pricing).toBe('plan'); // preview only

    await expectCode(billing.moveToAppPricing(deps, user('alice'), { orgId, apply: true, reason: 'Move to apps' }), 'permission-denied');
    await billing.moveToAppPricing(deps, billingStaff, { orgId, apply: true, reason: 'Move to app pricing' });
    const after = await sub();
    expect(after).toMatchObject({ pricing: 'apps', amountPerPeriodMinor: 4 * 59_900, adjustmentMinor: preview.adjustmentMinor });
    // Same features, except sensors (none in use, so not bought).
    expect((await ent()).features).toEqual(featuresBefore.filter((f) => f !== 'sensor.esp32'));
    await expectCode(billing.moveToAppPricing(deps, billingStaff, { orgId, apply: false }), 'failed-precondition');
  });
});
