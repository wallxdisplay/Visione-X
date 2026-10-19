import { createHmac } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paths, type PaymentDoc, type PaymentOrderDoc, type SubscriptionDoc } from '@wallx-play/shared';
import { changeApps } from '../../functions/src/billing/appStore';
import { confirmPayment, createPaymentOrder, handleRazorpayWebhook, updatePaymentSettings } from '../../functions/src/billing/online';
import type { Deps } from '../../functions/src/lib/context';
import { reviewOrgSignup } from '../../functions/src/orgs/review';
import { submitOrgSignup } from '../../functions/src/orgs/signup';
import { advance, db, deps as baseDeps, expectCode, resetEmulator, superadmin, user } from './helpers';

// Fake, test-only values: the Razorpay API is replaced below, nothing leaves the machine.
const KEY_SECRET = 'test-key-secret';
const WEBHOOK_SECRET = 'test-webhook-secret';
const DAY = 86_400_000;
const alice = user('alice'); // owner
let orgId: string;

/** A fake Razorpay API: orders get ids, payments are whatever the test says. */
const payments = new Map<string, { id: string; order_id: string; amount: number; currency: string; status: string }>();
let orderSeq = 0;
const fakeFetch = (async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname.replace('/v1', '');
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (init?.method === 'POST' && path === '/orders') return json({ id: `order_T${++orderSeq}abcdef`, amount: body.amount, currency: 'INR' });
  const pay = /^\/payments\/(pay_\w+)(\/capture)?$/.exec(path);
  if (pay) {
    const p = payments.get(pay[1]!);
    if (!p) return json({ error: { description: 'not found' } }, 404);
    if (pay[2]) p.status = 'captured';
    return json(p);
  }
  return json({ error: { description: 'unexpected' } }, 400);
}) as typeof fetch;
const deps: Deps = { ...baseDeps, fetch: fakeFetch };

const sub = async () => (await db.doc(paths.orgSubscription(orgId)).get()).data() as SubscriptionDoc;
const sign = (orderId: string, paymentId: string) => createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const webhook = (event: string, payment: unknown, secret = WEBHOOK_SECRET) => {
  const raw = JSON.stringify({ event, payload: { payment: { entity: payment } } });
  return handleRazorpayWebhook(deps, raw, createHmac('sha256', secret).update(raw).digest('hex'));
};
const enable = () => updatePaymentSettings(deps, superadmin, { enabled: true, supplierStateCode: '27', gstRateBps: 1800, trialPlanTo: 'starter' });

beforeAll(() => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

beforeEach(async () => {
  await resetEmulator();
  payments.clear();
  const r = await submitOrgSignup(deps, alice, {
    orgName: 'Acme', contactName: 'Asha', phone: '+91 98200 12345', city: 'Pune', stateCode: '27', expectedScreens: 2, timezone: 'Asia/Kolkata',
  });
  await reviewOrgSignup(deps, superadmin, { requestId: r.requestId, decision: 'approve' });
  orgId = r.orgId;
  await changeApps(deps, alice, { orgId, screens: 2, apps: [{ appId: 'weather', quantity: 1 }], apply: true });
});

describe('online payments', () => {
  it('is off until WallX switches it on', async () => {
    await expectCode(createPaymentOrder(deps, alice, { orgId, kind: 'renewal', periods: 1, create: false }), 'failed-precondition');
    await expectCode(createPaymentOrder(deps, user('mallory'), { orgId, kind: 'renewal', periods: 1, create: false }), 'permission-denied');
  });

  it('pays the first month at the end of the trial: price + GST, verified, then the paid plan', async () => {
    await enable();
    // 2 screens × ₹299 + Weather ₹49 = ₹647; GST 18% in Maharashtra = CGST ₹58.23 + SGST ₹58.23.
    const q = await createPaymentOrder(deps, alice, { orgId, kind: 'renewal', periods: 1, create: false });
    expect(q).toMatchObject({ periodMinor: 64_700, taxableMinor: 64_700, gst: { rateBps: 1800, cgstMinor: 5_823, sgstMinor: 5_823, igstMinor: 0 }, amountMinor: 76_346 });
    expect(q.order).toBeUndefined();

    const created = await createPaymentOrder(deps, alice, { orgId, kind: 'renewal', periods: 1, create: true });
    const orderId = created.order!.id;
    expect(created.order).toMatchObject({ keyId: 'rzp_test_fake', currency: 'INR' });
    expect(((await db.doc(paths.paymentOrder(orgId, orderId)).get()).data() as PaymentOrderDoc).status).toBe('created');

    payments.set('pay_T1abcdef', { id: 'pay_T1abcdef', order_id: orderId, amount: 76_346, currency: 'INR', status: 'authorized' });
    await expectCode(confirmPayment(deps, alice, { orgId, orderId, paymentId: 'pay_T1abcdef', signature: 'a'.repeat(64) }), 'permission-denied');
    const r = await confirmPayment(deps, alice, { orgId, orderId, paymentId: 'pay_T1abcdef', signature: sign(orderId, 'pay_T1abcdef') });
    expect(r.already).toBe(false);

    const s = await sub();
    expect(s).toMatchObject({ planId: 'starter', status: 'active', trialEndsAt: null, amountPerPeriodMinor: 64_700 });
    expect(s.currentPeriodEnd).toBe(r.periodEnd);
    const pay = (await db.doc(paths.payment(orgId, r.paymentId)).get()).data() as PaymentDoc;
    expect(pay).toMatchObject({ method: 'razorpay', amountMinor: 76_346, taxableMinor: 64_700, reference: 'pay_T1abcdef', gateway: { name: 'razorpay', orderId } });

    // The webhook for the same payment changes nothing.
    expect(await webhook('payment.captured', payments.get('pay_T1abcdef'))).toEqual({ status: 200, body: { settled: false } });
    expect((await db.collection(paths.payments(orgId)).get()).size).toBe(1);
  });

  it('App store charges can be paid on their own; the webhook records the payment if the browser never returns', async () => {
    await enable();
    const first = await createPaymentOrder(deps, alice, { orgId, kind: 'renewal', periods: 1, create: true });
    payments.set('pay_T2abcdef', { id: 'pay_T2abcdef', order_id: first.order!.id, amount: first.amountMinor, currency: 'INR', status: 'captured' });
    await confirmPayment(deps, alice, { orgId, orderId: first.order!.id, paymentId: 'pay_T2abcdef', signature: sign(first.order!.id, 'pay_T2abcdef') });
    const paid = await sub();

    advance(10 * DAY);
    await changeApps(deps, alice, { orgId, screens: 2, apps: [{ appId: 'weather', quantity: 2 }], apply: true });
    const charge = (await sub()).pendingCharges![0]!.amountMinor;
    const q = await createPaymentOrder(deps, alice, { orgId, kind: 'charges', periods: 1, create: true });
    expect(q).toMatchObject({ taxableMinor: charge, chargesMinor: charge, periodMinor: null });

    const p = { id: 'pay_T3abcdef', order_id: q.order!.id, amount: q.amountMinor, currency: 'INR', status: 'captured' };
    expect((await webhook('payment.captured', p, 'wrong')).status).toBe(401);
    expect((await webhook('payment.captured', { ...p, amount: 1 })).body).toEqual({ ignored: 'mismatch' });
    expect(await webhook('payment.captured', p)).toEqual({ status: 200, body: { settled: true } });

    const after = await sub();
    expect(after.pendingCharges).toEqual([]);
    expect(after.currentPeriodEnd).toBe(paid.currentPeriodEnd); // charges do not extend the period
    const last = (await db.collection(paths.payments(orgId)).orderBy('createdAt', 'desc').limit(1).get()).docs[0]!.data() as PaymentDoc;
    expect(last.charges?.[0]?.amountMinor).toBe(charge);
    await expectCode(createPaymentOrder(deps, alice, { orgId, kind: 'charges', periods: 1, create: false }), 'failed-precondition'); // nothing left
  });

  it('a plan-priced organization in its trial pays the paid plan price and moves to it', async () => {
    await enable();
    // Like organizations approved before app pricing: trial plan, plan pricing, 2 screens.
    await db.doc(paths.orgSubscription(orgId)).update({ pricing: 'plan', apps: [], quantity: 2 });
    const q = await createPaymentOrder(deps, alice, { orgId, kind: 'renewal', periods: 1, create: true });
    expect(q).toMatchObject({ periodMinor: 2 * 29_900, taxableMinor: 59_800, amountMinor: 70_564 });
    payments.set('pay_T4abcdef', { id: 'pay_T4abcdef', order_id: q.order!.id, amount: q.amountMinor, currency: 'INR', status: 'captured' });
    await confirmPayment(deps, alice, { orgId, orderId: q.order!.id, paymentId: 'pay_T4abcdef', signature: sign(q.order!.id, 'pay_T4abcdef') });
    expect(await sub()).toMatchObject({ planId: 'starter', pricing: 'plan', status: 'active', amountPerPeriodMinor: 59_800 });
  });

  it('staff cannot switch it on without the secrets', async () => {
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    try {
      await expectCode(enable(), 'failed-precondition');
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    }
  });
});
