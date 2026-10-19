/**
 * Online payments with Razorpay (App store phase 5). The owner of an organization billed by
 * WallX pays the next period(s) — with any App store charges waiting — or only those charges:
 *
 * 1. `createPaymentOrder` quotes the amount (price + GST) and, when asked, creates a Razorpay
 *    order. Checkout runs in the browser.
 * 2. `confirmPayment` gets Checkout's result; the signature, the payment's order, amount and
 *    capture are checked with Razorpay before anything is recorded.
 * 3. `razorpayWebhook` (payment.captured / order.paid) does the same if the browser never came
 *    back. Settling is idempotent: the first of the two records the payment.
 *
 * Secrets (set by WallX with `npx firebase functions:secrets:set`): RAZORPAY_KEY_ID,
 * RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET. Nothing here logs or returns the secrets.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onRequest } from 'firebase-functions/v2/https';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { computeGst } from '@wallx-play/billing-core';
import {
  DEFAULT_GST_RATE_BPS,
  PLATFORM_AUDIT_CHAIN,
  PRODUCT_NAME,
  billingState,
  paths,
  paymentPeriod,
  stateAfter,
  type ConfirmPaymentInput,
  type CreatePaymentOrderInput,
  type GstSplit,
  type OnlinePaymentSettings,
  type OrgDoc,
  type PaymentDoc,
  type PaymentOrderDoc,
  type PaymentQuote,
  type PlatformSettingsDoc,
  type SubscriptionDoc,
  type UpdatePaymentSettingsInput,
} from '@wallx-play/shared';
import { getDeps } from '../lib/admin';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { requireOrgPermission, requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { entitlementsForSub } from '../lib/entitlements';
import { notify } from '../lib/notify';
import { BASE_OPTIONS, PAYMENT_SECRETS } from '../options';
import { syncAndRepublish } from '../screens/screenApps';
import { dueScheduledChange, notifyStatusChange, readAppCatalog, readPlan, readSubscription, subscriptionAmount, writeSubscription } from './billing';

const config = () => ({
  keyId: process.env.RAZORPAY_KEY_ID?.trim() ?? '',
  keySecret: process.env.RAZORPAY_KEY_SECRET?.trim() ?? '',
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET?.trim() ?? '',
});

const hmac = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Calls the Razorpay API with the key pair (never logged). */
async function razorpay<T>(deps: Deps, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { keyId, keySecret } = config();
  const res = await (deps.fetch ?? fetch)(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
  if (!res.ok) {
    logger.error('Razorpay request failed', { path: path.replace(/\/(pay|order)_[A-Za-z0-9]+/g, '/$1_…'), status: res.status, error: json.error?.description });
    throw new HttpsError('unavailable', 'The payment service did not answer. Try again in a minute.');
  }
  return json as T;
}

async function readPaymentSettings(tx: Transaction, db: Firestore): Promise<OnlinePaymentSettings | null> {
  const s = (await tx.get(db.doc(paths.platformSettings()))).data() as PlatformSettingsDoc | undefined;
  return s?.payments ?? null;
}

function gstFor(taxableMinor: number, settings: OnlinePaymentSettings, org: OrgDoc): { gst: GstSplit; amountMinor: number } {
  const g = computeGst({
    taxableMinor,
    rateBps: settings.gstRateBps,
    supplierStateCode: settings.supplierStateCode,
    placeOfSupplyStateCode: org.contact?.stateCode || settings.supplierStateCode,
  });
  return { gst: { rateBps: settings.gstRateBps, cgstMinor: g.cgstMinor, sgstMinor: g.sgstMinor, igstMinor: g.igstMinor }, amountMinor: g.grandTotalMinor };
}

/**
 * The subscription a renewal pays for: reductions due by the new period's start applied, and an
 * organization still on the trial plan moved to the configured paid plan.
 */
function renewalSubscription(sub: SubscriptionDoc, settings: OnlinePaymentSettings, trialPlan: boolean, periodStart: number): SubscriptionDoc {
  const due = sub.scheduledChange && sub.scheduledChange.effectiveAt <= periodStart;
  const after = due ? stateAfter({ screens: sub.quantity, lines: sub.apps ?? [] }, sub.scheduledChange) : null;
  return {
    ...sub,
    ...(trialPlan && settings.trialPlanTo ? { planId: settings.trialPlanTo } : {}),
    ...(after
      ? {
          quantity: after.screens,
          apps: (sub.apps ?? []).filter((l) => after.lines.some((a) => a.appId === l.appId)).map((l) => ({ ...l, quantity: after.lines.find((a) => a.appId === l.appId)!.quantity })),
        }
      : {}),
  };
}

/** What a payment of this kind costs now (reads only). */
async function quote(
  tx: Transaction,
  db: Firestore,
  org: OrgDoc,
  sub: SubscriptionDoc,
  settings: OnlinePaymentSettings,
  kind: PaymentOrderDoc['kind'],
  periods: number,
  at: number,
): Promise<PaymentQuote & { chargeAts: number[] }> {
  const charges = sub.pendingCharges ?? [];
  const chargesMinor = charges.reduce((s, c) => s + c.amountMinor, 0);
  let periodMinor: number | null = null;
  let period: { start: number; end: number } | null = null;
  if (kind === 'renewal') {
    const current = await readPlan(tx, db, sub.planId);
    const trialPlan = current.tier === 'trial';
    if (trialPlan && !settings.trialPlanTo) {
      throw new HttpsError('failed-precondition', 'WallX sets your plan before the first payment. Send a billing request or contact WallX.');
    }
    period = paymentPeriod(sub, periods, at);
    const next = renewalSubscription(sub, settings, trialPlan, period.start);
    const plan = trialPlan ? await readPlan(tx, db, next.planId) : current;
    const catalog = next.pricing === 'apps' ? await readAppCatalog(tx, db) : [];
    periodMinor = subscriptionAmount(plan, next, catalog);
    if (periodMinor === null || periodMinor <= 0) {
      throw new HttpsError('failed-precondition', 'Your price is agreed with WallX, so it cannot be paid online. Contact WallX.');
    }
  } else if (chargesMinor <= 0) {
    throw new HttpsError('failed-precondition', 'There are no App store charges to pay.');
  }
  const taxableMinor = (periodMinor ?? 0) * (kind === 'renewal' ? periods : 0) + chargesMinor;
  const { gst, amountMinor } = gstFor(taxableMinor, settings, org);
  return {
    kind,
    periods: kind === 'renewal' ? periods : 0,
    periodMinor,
    chargesMinor,
    taxableMinor,
    gst,
    amountMinor,
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
    chargeAts: charges.map((c) => c.at),
  };
}

/** Owner: quote a payment, or create the Razorpay order Checkout opens. */
export async function createPaymentOrder(deps: Deps, actor: Actor, input: z.infer<typeof CreatePaymentOrderInput>): Promise<PaymentQuote> {
  const { db, now } = deps;
  const at = now();
  const q = await db.runTransaction(async (tx) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'billing.manage');
    const org = (await tx.get(db.doc(paths.org(input.orgId)))).data() as OrgDoc | undefined;
    if (!org || ['pending', 'info_requested', 'rejected'].includes(org.status)) throw new HttpsError('failed-precondition', 'Payments are available once the organization is approved.');
    const settings = await readPaymentSettings(tx, db);
    if (!settings?.enabled || !config().keyId || !config().keySecret) throw new HttpsError('failed-precondition', 'Online payment is not available yet. Pay by bank transfer or UPI as before.');
    const sub = await readSubscription(tx, db, input.orgId);
    if (sub.billedTo) throw new HttpsError('failed-precondition', 'Your reseller bills you. Pay them as agreed.');
    return quote(tx, db, org, sub, settings, input.kind, input.periods, at);
  });
  const { chargeAts, ...result } = q;
  if (!input.create) return result;

  const description = input.kind === 'renewal' ? `${PRODUCT_NAME} subscription, ${q.periods} period(s)` : `${PRODUCT_NAME} App store charges`;
  const order = await razorpay<{ id: string; amount: number }>(deps, 'POST', '/orders', {
    amount: q.amountMinor,
    currency: 'INR',
    receipt: `${input.orgId.slice(0, 24)}-${at}`.slice(0, 40),
    notes: { orgId: input.orgId, kind: input.kind, periods: String(q.periods) },
  });
  if (order.amount !== q.amountMinor) throw new HttpsError('internal', 'The payment service returned a different amount.');
  const doc: PaymentOrderDoc = {
    id: order.id,
    orgId: input.orgId,
    gateway: 'razorpay',
    kind: input.kind,
    periods: q.periods,
    taxableMinor: q.taxableMinor,
    gst: q.gst,
    amountMinor: q.amountMinor,
    chargeAts,
    status: 'created',
    createdBy: actor.uid,
    createdAt: at,
    paidAt: null,
    gatewayPaymentId: null,
    paymentId: null,
  };
  const batch = db.batch();
  batch.set(db.doc(paths.paymentOrder(input.orgId, order.id)), doc);
  // The webhook only knows the order id: this maps it to the organization.
  batch.set(db.doc(paths.onlineOrder(order.id)), { orgId: input.orgId, createdAt: at });
  await batch.commit();
  return { ...result, order: { id: order.id, keyId: config().keyId, currency: 'INR', email: actor.email, name: PRODUCT_NAME, description } };
}

interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
}

/** Checks the payment with Razorpay (captures it if only authorized) and records it. */
export async function confirmPayment(deps: Deps, actor: Actor, input: z.infer<typeof ConfirmPaymentInput>): Promise<{ paymentId: string; periodEnd: number | null; already: boolean }> {
  const { db } = deps;
  await db.runTransaction((tx) => requireOrgPermission(tx, db, actor, input.orgId, 'billing.manage'));
  const { keySecret } = config();
  if (!keySecret || !sameHex(hmac(keySecret, `${input.orderId}|${input.paymentId}`), input.signature)) {
    throw new HttpsError('permission-denied', 'This payment could not be verified.');
  }
  const order = (await db.doc(paths.paymentOrder(input.orgId, input.orderId)).get()).data() as PaymentOrderDoc | undefined;
  if (!order) throw new HttpsError('not-found', 'Payment order not found.');
  let payment = await razorpay<RazorpayPayment>(deps, 'GET', `/payments/${input.paymentId}`);
  if (payment.order_id !== order.id || payment.amount !== order.amountMinor || payment.currency !== 'INR') {
    throw new HttpsError('permission-denied', 'This payment does not match the order.');
  }
  if (payment.status === 'authorized') {
    payment = await razorpay<RazorpayPayment>(deps, 'POST', `/payments/${input.paymentId}/capture`, { amount: order.amountMinor, currency: 'INR' });
  }
  if (payment.status !== 'captured') throw new HttpsError('failed-precondition', 'The payment is not complete yet. If money was taken, it is recorded within a few minutes.');
  return settleOrder(deps, input.orgId, order.id, payment.id);
}

/** Records a captured payment for an order once (later calls return the first result). */
export async function settleOrder(deps: Deps, orgId: string, orderId: string, gatewayPaymentId: string): Promise<{ paymentId: string; periodEnd: number | null; already: boolean }> {
  const { db, now } = deps;
  const at = now();
  const ref = db.collection(paths.payments(orgId)).doc();
  const result = await auditedTransaction(db, [orgId], async (tx, audit) => {
    const orderRef = db.doc(paths.paymentOrder(orgId, orderId));
    const order = (await tx.get(orderRef)).data() as PaymentOrderDoc | undefined;
    if (!order) throw new HttpsError('not-found', 'Payment order not found.');
    if (order.status === 'paid') return { paymentId: order.paymentId!, periodEnd: null, already: true };
    const sub = await readSubscription(tx, db, orgId);
    const settings = (await readPaymentSettings(tx, db)) ?? { enabled: true, supplierStateCode: '', gstRateBps: DEFAULT_GST_RATE_BPS, trialPlanTo: null };
    const collected = (sub.pendingCharges ?? []).filter((c) => order.chargeAts.includes(c.at));
    const remaining = (sub.pendingCharges ?? []).filter((c) => !order.chargeAts.includes(c.at));

    let next: SubscriptionDoc;
    let period: { start: number; end: number };
    let entitlements = null;
    if (order.kind === 'renewal') {
      period = paymentPeriod(sub, order.periods, at);
      const trialPlan = (await readPlan(tx, db, sub.planId)).tier === 'trial';
      const base = (await dueScheduledChange(tx, db, sub, at)) ?? sub;
      const moved: SubscriptionDoc = trialPlan && settings.trialPlanTo ? { ...base, planId: settings.trialPlanTo } : base;
      const plan = await readPlan(tx, db, moved.planId);
      const catalog = moved.pricing === 'apps' ? await readAppCatalog(tx, db) : [];
      next = {
        ...moved,
        amountPerPeriodMinor: subscriptionAmount(plan, moved, catalog),
        pendingCharges: remaining,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        lastPaymentAt: at,
        updatedAt: at,
        updatedBy: 'razorpay',
      };
      entitlements = await entitlementsForSub(tx, db, orgId, { ...next, status: billingState(next, at).status }, at);
    } else {
      period = { start: sub.currentPeriodStart ?? at, end: sub.currentPeriodEnd ?? at };
      next = { ...sub, pendingCharges: remaining, updatedAt: at, updatedBy: 'razorpay' };
    }
    const payment: PaymentDoc = {
      id: ref.id,
      amountMinor: order.amountMinor,
      currency: 'INR',
      method: 'razorpay',
      reference: gatewayPaymentId,
      externalInvoiceNo: null,
      paidAt: at,
      periodStart: period.start,
      periodEnd: period.end,
      note: null,
      recordedBy: 'razorpay',
      recordedByEmail: null,
      createdAt: at,
      voided: null,
      ...(collected.length ? { charges: collected } : {}),
      taxableMinor: order.taxableMinor,
      gst: order.gst,
      gateway: { name: 'razorpay', orderId, paymentId: gatewayPaymentId },
    };
    tx.create(ref, payment);
    const written = writeSubscription(tx, db, orgId, next, at);
    if (entitlements) tx.set(db.doc(paths.orgEntitlements(orgId)), entitlements);
    tx.update(orderRef, { status: 'paid', paidAt: at, gatewayPaymentId, paymentId: ref.id });
    notify(tx, db, orgId, 'billing_payment_recorded', { amount: order.amountMinor, until: period.end }, '/billing', at);
    notifyStatusChange(tx, db, orgId, sub.status, written.status, at);
    audit(orgId, {
      at,
      actorType: 'system',
      actorId: 'razorpay',
      orgId,
      action: 'billing.payment.online',
      target: { type: 'subscription', id: orgId },
      data: { paymentId: ref.id, orderId, gatewayPaymentId, kind: order.kind, amountMinor: order.amountMinor, taxableMinor: order.taxableMinor, periodEnd: period.end, planId: next.planId },
    });
    return { paymentId: ref.id, periodEnd: order.kind === 'renewal' ? period.end : null, already: false };
  });
  // A new period (or plan) can change which screens hold which apps.
  if (!result.already) await syncAndRepublish(deps, orgId);
  return result;
}

/** Razorpay webhook: verified with the webhook secret, then settles captured payments. */
export async function handleRazorpayWebhook(deps: Deps, rawBody: Buffer | string, signature: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { webhookSecret } = config();
  if (!webhookSecret) return { status: 503, body: { error: 'not_configured' } };
  if (!signature || !sameHex(hmac(webhookSecret, rawBody), signature)) return { status: 401, body: { error: 'bad_signature' } };
  const event = JSON.parse(rawBody.toString()) as { event?: string; payload?: { payment?: { entity?: RazorpayPayment } } };
  if (event.event !== 'payment.captured' && event.event !== 'order.paid') return { status: 200, body: { ignored: event.event ?? null } };
  const payment = event.payload?.payment?.entity;
  if (!payment?.order_id || payment.status !== 'captured') return { status: 200, body: { ignored: 'not_captured' } };
  const map = (await deps.db.doc(paths.onlineOrder(payment.order_id)).get()).data() as { orgId?: string } | undefined;
  if (!map?.orgId) return { status: 200, body: { ignored: 'unknown_order' } };
  const order = (await deps.db.doc(paths.paymentOrder(map.orgId, payment.order_id)).get()).data() as PaymentOrderDoc | undefined;
  if (!order || payment.amount !== order.amountMinor || payment.currency !== 'INR') {
    logger.error('Razorpay webhook: payment does not match its order', { orgId: map.orgId, orderId: payment.order_id });
    return { status: 200, body: { ignored: 'mismatch' } };
  }
  const r = await settleOrder(deps, map.orgId, order.id, payment.id);
  return { status: 200, body: { settled: !r.already } };
}

export const razorpayWebhook = onRequest({ ...BASE_OPTIONS, cors: false, memory: '256MiB', secrets: PAYMENT_SECRETS }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  try {
    const r = await handleRazorpayWebhook(getDeps(), req.rawBody, String(req.headers['x-razorpay-signature'] ?? ''));
    res.status(r.status).json(r.body);
  } catch (err) {
    logger.error('Razorpay webhook failed', { err: String(err) });
    // Razorpay retries non-2xx responses.
    res.status(500).json({ error: 'internal' });
  }
});

/** Super Admin: switch online payments on or off; GST and trial-conversion settings. */
export async function updatePaymentSettings({ db, now }: Deps, actor: Actor, input: z.infer<typeof UpdatePaymentSettingsInput>): Promise<void> {
  requirePlatform(actor, 'settings.edit');
  const { keyId, keySecret, webhookSecret } = config();
  if (input.enabled && (!keyId || !keySecret || !webhookSecret)) {
    throw new HttpsError('failed-precondition', 'Set the Razorpay secrets (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET) and deploy before switching online payment on.');
  }
  const ref = db.doc(paths.platformSettings());
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    if (input.trialPlanTo) {
      const plan = (await tx.get(db.doc(paths.plan(input.trialPlanTo)))).data() as { tier?: string; active?: boolean } | undefined;
      if (!plan || plan.tier === 'trial') throw new HttpsError('invalid-argument', 'Choose a paid plan for trial conversions.');
    }
    const before = ((await tx.get(ref)).data() ?? {}) as PlatformSettingsDoc;
    const at = now();
    tx.set(ref, { payments: input, updatedAt: at, updatedBy: actor.uid }, { merge: true });
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: 'platform.payments.updated',
      target: { type: 'platformSettings', id: 'settings' },
      data: { from: before.payments ?? null, to: input, testMode: keyId.startsWith('rzp_test_') },
    });
  });
}
