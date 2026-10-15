import { FieldValue } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BILLING_GRACE_DAYS,
  addMonths,
  paths,
  type AuditDoc,
  type EntitlementsDoc,
  type NotificationDoc,
  type OrgDoc,
  type PaymentDoc,
  type SubscriptionDoc,
} from '@wallx-play/shared';
import * as billing from '../../functions/src/billing/billing';
import * as plans from '../../functions/src/billing/plans';
import * as layouts from '../../functions/src/content/layouts';
import * as members from '../../functions/src/members/members';
import { runMonitor } from '../../functions/src/ops/monitor';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { upsertSite } from '../../functions/src/orgs/settings';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { SEED_PLANS } from '../../functions/src/seed/data';
import { advance, db, deps, expectCode, resetEmulator, superadmin, user } from './helpers';

const DAY = 86_400_000;
const alice = user('alice');
const billingStaff = user('bill', { platformRole: 'billing' });
const support = user('sup', { platformRole: 'support' });
let orgId: string;

const sub = async () => (await db.doc(paths.orgSubscription(orgId)).get()).data() as SubscriptionDoc;
const org = async () => (await db.doc(paths.org(orgId)).get()).data() as OrgDoc;
const ent = async () => (await db.doc(paths.orgEntitlements(orgId)).get()).data() as EntitlementsDoc;
const notes = async () =>
  (await db.collection(paths.notifications(orgId)).orderBy('createdAt').get()).docs.map((d) => (d.data() as NotificationDoc).type);
const layout = () =>
  layouts.saveLayout(deps, alice, {
    orgId,
    layout: { name: 'L', canvas: { width: 1920, height: 1080, orientation: 'landscape', background: '#000000' }, zones: [] },
  });
const pay = (over: Partial<Parameters<typeof billing.recordPayment>[2]> = {}) =>
  billing.recordPayment(deps, billingStaff, { orgId, amountMinor: 59_800, method: 'upi', reference: 'UTR-1', paidAt: deps.now(), periods: 1, ...over });

beforeEach(async () => {
  await resetEmulator();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Billing Co',
    contactName: 'Asha',
    phone: '+91 98200 12345',
    city: 'Mumbai',
    stateCode: '27',
    expectedScreens: 3,
    timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
});

describe('trial and payments', () => {
  it('approval starts a trial; the org carries a billing summary', async () => {
    const s = await sub();
    expect(s).toMatchObject({ planId: 'trial', status: 'trialing', quantity: 2, gateway: 'manual', currentPeriodEnd: null });
    expect(s.trialEndsAt).toBe(deps.now() + 14 * DAY);
    expect(s.nextTransitionAt).toBe(s.trialEndsAt! - 3 * DAY);
    expect((await org()).billing).toMatchObject({ status: 'trialing', restricted: false, planId: 'trial' });
  });

  it('billing staff record a payment: active for one period; others may not', async () => {
    await billing.updateSubscription(deps, billingStaff, { orgId, planId: 'starter', interval: 'monthly', quantity: 2, customPriceMinor: null, discountBps: 0, reason: 'Customer chose Starter' });
    await pay();
    await expectCode(billing.recordPayment(deps, support, { orgId, amountMinor: 1, method: 'upi', reference: 'x', paidAt: deps.now(), periods: 1 }), 'permission-denied');
    await expectCode(billing.recordPayment(deps, alice, { orgId, amountMinor: 1, method: 'upi', reference: 'x', paidAt: deps.now(), periods: 1 }), 'permission-denied');

    const s = await sub();
    expect(s).toMatchObject({ status: 'active', trialEndsAt: null, amountPerPeriodMinor: 59_800 });
    expect(s.currentPeriodEnd).toBe(addMonths(deps.now(), 1));
    const payments = (await db.collection(paths.payments(orgId)).get()).docs.map((d) => d.data() as PaymentDoc);
    expect(payments).toEqual([expect.objectContaining({ amountMinor: 59_800, method: 'upi', reference: 'UTR-1', recordedBy: 'bill', voided: null })]);
    expect(await notes()).toContain('billing_payment_recorded');

    await billing.voidPayment(deps, billingStaff, { orgId, paymentId: payments[0]!.id, reason: 'UPI reversal' });
    expect(((await db.doc(paths.payment(orgId, payments[0]!.id)).get()).data() as PaymentDoc).voided?.reason).toBe('UPI reversal');
  });

  it('plan changes set the screen limit to the screens purchased and price the period', async () => {
    // Plan pricing (new organizations start on app pricing; see apps.test.ts).
    await billing.updateSubscription(deps, billingStaff, { orgId, planId: 'professional', interval: 'annual', quantity: 5, customPriceMinor: null, discountBps: 1000, pricing: 'plan', reason: 'Annual deal, 10% extra' });
    expect((await ent()).limits.screens).toBe(5);
    expect((await ent()).features).toContain('content.approvals');
    // ₹599 × 5 × 12 = ₹35,940; −15% annual = ₹30,549; −10% extra = ₹27,494.10
    expect((await sub()).amountPerPeriodMinor).toBe(2_749_410);
    await expectCode(
      billing.updateSubscription(deps, billingStaff, { orgId, planId: 'nope', interval: 'monthly', quantity: 1, customPriceMinor: null, discountBps: 0, reason: 'Testing a bad plan' }),
      'invalid-argument',
    );
    const audit = (await db.collection(paths.auditLogs()).where('chainId', '==', orgId).where('action', '==', 'billing.subscription.updated').get()).docs.map((d) => d.data() as AuditDoc);
    expect(audit[0]).toMatchObject({ actorId: 'bill', reason: 'Annual deal, 10% extra' });
  });
});

describe('lifecycle via the monitor', () => {
  it('trial reminder, then restricted: editing is locked but settings still work; paying unlocks', async () => {
    advance(11 * DAY);
    expect(await runMonitor(deps)).toMatchObject({ billingReminders: 1, billingTransitions: 0 });
    advance(3 * DAY);
    expect(await runMonitor(deps)).toMatchObject({ billingTransitions: 1 });
    expect((await org()).billing).toMatchObject({ status: 'restricted', restricted: true });
    expect(await notes()).toEqual(['billing_trial_ending', 'billing_restricted']);

    await expectCode(layout(), 'failed-precondition');
    await upsertSite(deps, alice, { orgId, name: 'HQ', timezone: 'Asia/Kolkata' });

    await pay();
    expect((await org()).billing?.restricted).toBe(false);
    await layout();
  });

  it('active → past due (grace) → restricted; renewal in grace keeps the billing date', async () => {
    await pay();
    const end = (await sub()).currentPeriodEnd!;
    advance(end - deps.now() - 7 * DAY);
    await runMonitor(deps); // renewal reminder
    advance(7 * DAY);
    await runMonitor(deps);
    expect((await sub()).status).toBe('past_due');
    await layout(); // still allowed during grace

    advance(2 * DAY);
    await pay({ reference: 'UTR-2' });
    expect((await sub()).currentPeriodEnd).toBe(addMonths(end, 1));

    advance(addMonths(end, 1) - deps.now() + BILLING_GRACE_DAYS * DAY);
    await runMonitor(deps);
    expect((await sub()).status).toBe('restricted');
    expect(await notes()).toEqual(expect.arrayContaining(['billing_due_soon', 'billing_past_due', 'billing_restricted']));
  });

  it('cancel at period end ends without grace; dates can be adjusted with a reason', async () => {
    await pay();
    await billing.setCancellation(deps, billingStaff, { orgId, cancelAtPeriodEnd: true, reason: 'Customer is closing the store' });
    advance((await sub()).currentPeriodEnd! - deps.now());
    await runMonitor(deps);
    expect((await sub()).status).toBe('cancelled');

    const extended = await billing.adjustBillingDates(deps, billingStaff, { orgId, currentPeriodEnd: deps.now() + 10 * DAY, reason: 'Goodwill extension' });
    expect(extended.status).toBe('active');
    expect((await org()).billing?.restricted).toBe(false);
  });
});

describe('legacy subscriptions', () => {
  it('are read safely and upgraded once by a superadmin', async () => {
    await db.doc(paths.orgSubscription(orgId)).set({ planId: 'trial', status: 'trialing', trialEndsAt: deps.now() + DAY, updatedAt: 1 });
    await db.doc(paths.org(orgId)).update({ billing: FieldValue.delete() });
    await expectCode(billing.migrateSubscriptions(deps, billingStaff), 'permission-denied');
    expect(await billing.migrateSubscriptions(deps, superadmin)).toEqual({ migrated: 1 });
    expect(await sub()).toMatchObject({ gateway: 'manual', quantity: 2, reminders: [], status: 'trialing' });
    expect((await org()).billing).toMatchObject({ status: 'trialing', restricted: false });
    expect(await billing.migrateSubscriptions(deps, superadmin)).toEqual({ migrated: 0 });
  });
});

describe('customer requests', () => {
  it('owners request changes; billing staff resolve them', async () => {
    const { token } = await members.inviteMember(deps, alice, { orgId, email: 'ed@example.com', role: 'admin' });
    await members.acceptInvite(deps, user('ed'), { token });
    const input = { orgId, kind: 'add_screens' as const, quantity: 4, message: 'Two more screens for the new branch' };
    await expectCode(billing.requestBillingChange(deps, user('ed'), input), 'permission-denied'); // admins lack billing.manage
    const { requestId } = await billing.requestBillingChange(deps, alice, input);

    await billing.resolveBillingRequest(deps, billingStaff, { orgId, requestId, status: 'done', note: 'Quantity raised to 4' });
    const req = (await db.doc(paths.billingRequest(orgId, requestId)).get()).data();
    expect(req).toMatchObject({ status: 'done', resolvedBy: 'bill', orgName: 'Billing Co' });
    expect(await notes()).toContain('billing_request_resolved');
  });
});

describe('plans, release status and overrides', () => {
  it('editing a plan recomputes entitlements of orgs on it', async () => {
    const trial = SEED_PLANS.find((p) => p.id === 'trial')!;
    type PlanInput = Parameters<typeof plans.savePlan>[2];
    const input = { ...trial, isNew: false, limits: { ...trial.limits, screens: 3 }, reason: 'Trial now allows 3 screens' } as PlanInput;
    const { orgsUpdated } = await plans.savePlan(deps, superadmin, input);
    expect(orgsUpdated).toBe(1);
    expect((await ent()).limits.screens).toBe(3);
    await expectCode(plans.savePlan(deps, support, input), 'permission-denied');
  });

  it('release status and per-org overrides change what the org may use', async () => {
    expect((await ent()).features).toContain('sensor.esp32');
    await plans.setFeatureRelease(deps, superadmin, { key: 'sensor.esp32', releaseStatus: 'planned', reason: 'Pausing the sensor rollout' });
    expect((await ent()).features).not.toContain('sensor.esp32');

    await plans.setEntitlementOverrides(deps, superadmin, { orgId, grant: ['content.approvals'], revoke: [], limits: { users: 10 }, reason: 'Pilot customer' });
    const e = await ent();
    expect(e.features).toContain('content.approvals');
    expect(e.limits.users).toBe(10);
  });
});
