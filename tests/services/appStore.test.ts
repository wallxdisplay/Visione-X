import { beforeEach, describe, expect, it } from 'vitest';
import { paths, periodLeftBps, type PaymentDoc, type SubscriptionDoc } from '@wallx-play/shared';
import { changeApps } from '../../functions/src/billing/appStore';
import * as billing from '../../functions/src/billing/billing';
import { runMonitor } from '../../functions/src/ops/monitor';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const DAY = 86_400_000;
const alice = user('alice'); // owner
const billingStaff = user('bill', { platformRole: 'billing' });
let orgId: string;

const sub = async () => (await db.doc(paths.orgSubscription(orgId)).get()).data() as SubscriptionDoc;
const change = (screens: number, apps: Array<{ appId: string; quantity: number }>, apply = true) => changeApps(deps, alice, { orgId, screens, apps, apply });
/** WallX moves the organization from the trial plan to a paid plan, keeping its apps. */
const toStarter = async () => {
  const cur = await sub();
  await billing.updateSubscription(deps, billingStaff, { orgId, planId: 'starter', interval: 'monthly', quantity: cur.quantity, customPriceMinor: null, discountBps: 0, repriceApps: false, reason: 'Trial converted' });
};
const pay = () => billing.recordPayment(deps, billingStaff, { orgId, amountMinor: 1, method: 'upi', reference: 'UTR-1', paidAt: deps.now(), periods: 1 });

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Acme', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

describe('App store', () => {
  it('in the trial changes apply at once and cost nothing', async () => {
    await expectCode(changeApps(deps, user('mallory'), { orgId, screens: 3, apps: [], apply: true }), 'permission-denied');
    const r = await change(3, [{ appId: 'weather', quantity: 2 }]);
    expect(r).toMatchObject({ applied: true, trialing: true, chargeMinor: 0, effectiveAt: null });
    expect(await sub()).toMatchObject({ quantity: 3, amountPerPeriodMinor: null, scheduledChange: null });
    expect((await sub()).apps?.map((l) => [l.appId, l.quantity])).toEqual([['weather', 2]]);
    await expectCode(change(3, [{ appId: 'weather', quantity: 2 }]), 'failed-precondition'); // nothing to change
    await expectCode(change(3, [{ appId: 'touch', quantity: 1 }]), 'failed-precondition'); // coming soon
    await expectCode(change(3, [{ appId: 'weather', quantity: 4 }]), 'invalid-argument'); // more than the screens
  });

  it('in a paid period additions are charged pro rata with the next payment and removals wait for the period end', async () => {
    await change(3, [{ appId: 'weather', quantity: 2 }]);
    await toStarter();
    await pay();
    advance(10 * DAY);
    const paid = await sub();
    expect(paid.amountPerPeriodMinor).toBe(3 * 29_900 + 2 * 4_900);

    // Preview first: nothing is written.
    const preview = await change(3, [{ appId: 'weather', quantity: 3 }], false);
    const left = periodLeftBps(paid.currentPeriodStart, paid.currentPeriodEnd, deps.now());
    expect(preview).toMatchObject({ applied: false, chargeMinor: Math.round((4_900 * left) / 10_000), nowMinor: paid.amountPerPeriodMinor! + 4_900 });
    expect((await sub()).apps?.[0]?.quantity).toBe(2);

    await change(3, [{ appId: 'weather', quantity: 3 }]);
    const added = await sub();
    expect(added.apps?.[0]?.quantity).toBe(3);
    expect(added.pendingCharges).toHaveLength(1);
    expect(added.pendingCharges![0]).toMatchObject({ amountMinor: preview.chargeMinor, items: [{ item: 'weather', from: 2, to: 3 }] });

    // Removing weather: it stays until the paid period ends.
    const removal = await change(3, []);
    expect(removal).toMatchObject({ chargeMinor: 0, effectiveAt: paid.currentPeriodEnd, laterMinor: 3 * 29_900 });
    const scheduled = await sub();
    expect(scheduled.apps?.[0]?.quantity).toBe(3);
    expect(scheduled.scheduledChange).toMatchObject({ apps: [{ appId: 'weather', quantity: 0 }], effectiveAt: paid.currentPeriodEnd });
    expect(scheduled.nextTransitionAt).toBeLessThanOrEqual(paid.currentPeriodEnd!); // the monitor wakes by then

    // The renewal payment collects the charge; the removal still waits for the old period's end.
    await pay();
    const payments = await db.collection(paths.payments(orgId)).orderBy('createdAt', 'desc').limit(1).get();
    expect((payments.docs[0]!.data() as PaymentDoc).charges?.[0]?.amountMinor).toBe(preview.chargeMinor);
    expect((await sub()).pendingCharges).toEqual([]);
    expect((await sub()).apps?.[0]?.quantity).toBe(3);

    advance(paid.currentPeriodEnd! - deps.now() + 60_000);
    await runMonitor(deps);
    const after = await sub();
    expect(after.apps).toEqual([]);
    expect(after.scheduledChange).toBeNull();
    expect(after.amountPerPeriodMinor).toBe(3 * 29_900);
    expect((await db.doc(paths.orgEntitlements(orgId)).get()).data()!.features).not.toContain('widget.weather');
  });

  it('keeping an app cancels its scheduled removal', async () => {
    await change(3, [{ appId: 'weather', quantity: 2 }]);
    await toStarter();
    await pay();
    await change(3, [{ appId: 'weather', quantity: 1 }]);
    expect((await sub()).scheduledChange?.apps).toEqual([{ appId: 'weather', quantity: 1 }]);
    await change(3, [{ appId: 'weather', quantity: 2 }]);
    expect((await sub()).scheduledChange).toBeNull();
  });

  it('plan-priced organizations ask WallX instead', async () => {
    await billing.updateSubscription(deps, billingStaff, { orgId, planId: 'starter', interval: 'monthly', quantity: 2, customPriceMinor: null, discountBps: 0, pricing: 'plan', repriceApps: false, reason: 'Plan customer' });
    await expectCode(change(2, []), 'failed-precondition');
  });
});
