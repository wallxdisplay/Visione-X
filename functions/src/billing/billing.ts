/**
 * Subscriptions and manual payments. Billing staff (platform roles with billing.override)
 * change plans, record payments and adjust dates; customers see their subscription and send
 * change requests. Tax invoices come from a separate invoicing app and are not created here.
 * Every change recomputes the derived status, keeps orgs/{id}.billing in sync and is audited.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { subscriptionAmountMinor } from '@wallx-play/billing-core';
import {
  billingState,
  isLegacySubscription,
  isRestricted,
  normalizeSubscription,
  paths,
  paymentPeriod,
  type AdjustBillingDatesInput,
  type BillingRequestDoc,
  type OrgBillingSummary,
  type OrgDoc,
  type PaymentDoc,
  type Plan,
  type RecordPaymentInput,
  type RequestBillingChangeInput,
  type ResolveBillingRequestInput,
  type SetCancellationInput,
  type SubscriptionDoc,
  type UpdateSubscriptionInput,
  type VoidPaymentInput,
} from '@wallx-play/shared';
import { userAudit } from '../content/media';
import { auditedTransaction, platformAudit, type RecordAudit } from '../lib/audit';
import { getOrg, requireOrgPermission, requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { computeEntitlements } from '../lib/entitlements';
import { notify } from '../lib/notify';

/** Price per billing period before GST; null when neither the plan nor the deal has a price. */
export function periodAmount(plan: Pick<Plan, 'pricePerScreenMonthlyMinor' | 'annualDiscountBps'>, sub: Pick<SubscriptionDoc, 'customPriceMinor' | 'quantity' | 'interval' | 'discountBps'>): number | null {
  const price = sub.customPriceMinor ?? plan.pricePerScreenMonthlyMinor;
  if (price === null) return null;
  return subscriptionAmountMinor({
    pricePerScreenMonthlyMinor: price,
    screens: sub.quantity,
    interval: sub.interval,
    annualDiscountBps: plan.annualDiscountBps,
    extraDiscountBps: sub.discountBps,
  });
}

export const summaryOf = (sub: SubscriptionDoc): OrgBillingSummary => ({
  status: sub.status,
  restricted: isRestricted(sub.status),
  planId: sub.planId,
  trialEndsAt: sub.trialEndsAt,
  currentPeriodEnd: sub.currentPeriodEnd,
});

/** Applies derived status + next transition and writes subscription and org summary. */
export function writeSubscription(tx: Transaction, db: Firestore, orgId: string, sub: SubscriptionDoc, now: number): SubscriptionDoc {
  const state = billingState(sub, now);
  const next: SubscriptionDoc = { ...sub, status: state.status, nextTransitionAt: state.nextTransitionAt };
  tx.set(db.doc(paths.orgSubscription(orgId)), next);
  tx.update(db.doc(paths.org(orgId)), { billing: summaryOf(next), updatedAt: now });
  return next;
}

async function readSubscription(tx: Transaction, db: Firestore, orgId: string): Promise<SubscriptionDoc> {
  const snap = await tx.get(db.doc(paths.orgSubscription(orgId)));
  if (!snap.exists) throw new HttpsError('failed-precondition', 'This organization has no subscription yet (it is not approved).');
  return normalizeSubscription(snap.data() as SubscriptionDoc);
}

async function readPlan(tx: Transaction, db: Firestore, planId: string): Promise<Plan> {
  const snap = await tx.get(db.doc(paths.plan(planId)));
  if (!snap.exists) throw new HttpsError('invalid-argument', `Plan “${planId}” does not exist.`);
  return snap.data() as Plan;
}

/** Notifies the org when its status moved into a state that needs attention. */
export function notifyStatusChange(tx: Transaction, db: Firestore, orgId: string, from: SubscriptionDoc['status'], to: SubscriptionDoc['status'], at: number) {
  if (from === to) return;
  if (to === 'past_due') notify(tx, db, orgId, 'billing_past_due', {}, '/billing', at);
  if (isRestricted(to) && !isRestricted(from)) notify(tx, db, orgId, 'billing_restricted', {}, '/billing', at);
}

function auditBilling(audit: RecordAudit, actor: Actor, orgId: string, action: string, reason: string | undefined, data: Record<string, unknown>, at: number) {
  audit(orgId, {
    at,
    ...platformAudit(actor),
    orgId,
    action,
    target: { type: 'subscription', id: orgId },
    ...(reason ? { reason } : {}),
    data,
  });
}

/** Plan, interval, screens purchased and pricing (billing staff). */
export async function updateSubscription({ db, now }: Deps, actor: Actor, input: z.infer<typeof UpdateSubscriptionInput>): Promise<SubscriptionDoc> {
  requirePlatform(actor, 'billing.override');
  const at = now();
  return auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const org = await getOrg(tx, db, input.orgId);
    const sub = await readSubscription(tx, db, input.orgId);
    const plan = await readPlan(tx, db, input.planId);
    if (!plan.active && plan.id !== sub.planId) throw new HttpsError('failed-precondition', `Plan “${plan.name}” is not active.`);
    const authorized = await tx.get(db.collection(paths.screens(input.orgId)).where('status', '==', 'authorized').count());
    const fixedLimit = plan.limits.screens;
    const allowed = fixedLimit ?? input.quantity;
    if (authorized.data().count > allowed) {
      throw new HttpsError(
        'failed-precondition',
        `${org.name} has ${authorized.data().count} authorized screens; this plan allows ${allowed}. Remove screens first or buy more.`,
      );
    }
    const entitlements = await computeEntitlements(tx, db, input.orgId, plan.id, at, input.quantity);

    const draft: SubscriptionDoc = {
      ...sub,
      planId: plan.id,
      interval: input.interval,
      quantity: input.quantity,
      customPriceMinor: input.customPriceMinor,
      discountBps: input.discountBps,
      amountPerPeriodMinor: null,
      updatedAt: at,
      updatedBy: actor.uid,
    };
    draft.amountPerPeriodMinor = periodAmount(plan, draft);
    const next = writeSubscription(tx, db, input.orgId, draft, at);
    tx.set(db.doc(paths.orgEntitlements(input.orgId)), entitlements);
    notifyStatusChange(tx, db, input.orgId, sub.status, next.status, at);
    auditBilling(audit, actor, input.orgId, 'billing.subscription.updated', input.reason, {
      from: { planId: sub.planId, interval: sub.interval, quantity: sub.quantity, customPriceMinor: sub.customPriceMinor, discountBps: sub.discountBps },
      to: { planId: plan.id, interval: input.interval, quantity: input.quantity, customPriceMinor: input.customPriceMinor, discountBps: input.discountBps },
    }, at);
    return next;
  });
}

/** Records a payment received outside the app and extends the paid period. */
export async function recordPayment({ db, now }: Deps, actor: Actor, input: z.infer<typeof RecordPaymentInput>): Promise<{ paymentId: string; periodEnd: number }> {
  requirePlatform(actor, 'billing.override');
  const at = now();
  if (input.paidAt > at + 86_400_000) throw new HttpsError('invalid-argument', 'The payment date is in the future.');
  const ref = db.collection(paths.payments(input.orgId)).doc();
  return auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await getOrg(tx, db, input.orgId);
    const sub = await readSubscription(tx, db, input.orgId);
    const period = paymentPeriod(sub, input.periods, at);
    const payment: PaymentDoc = {
      id: ref.id,
      amountMinor: input.amountMinor,
      currency: 'INR',
      method: input.method,
      reference: input.reference,
      externalInvoiceNo: input.externalInvoiceNo || null,
      paidAt: input.paidAt,
      periodStart: period.start,
      periodEnd: period.end,
      note: input.note || null,
      recordedBy: actor.uid,
      recordedByEmail: actor.email,
      createdAt: at,
      voided: null,
    };
    tx.create(ref, payment);
    const next = writeSubscription(
      tx,
      db,
      input.orgId,
      {
        ...sub,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        // Paying ends the trial; the paid period takes over.
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        lastPaymentAt: input.paidAt,
        updatedAt: at,
        updatedBy: actor.uid,
      },
      at,
    );
    notify(tx, db, input.orgId, 'billing_payment_recorded', { amount: input.amountMinor, until: period.end }, '/billing', at);
    auditBilling(audit, actor, input.orgId, 'billing.payment.recorded', undefined, {
      paymentId: ref.id,
      amountMinor: input.amountMinor,
      method: input.method,
      reference: input.reference,
      externalInvoiceNo: input.externalInvoiceNo ?? null,
      periodEnd: period.end,
      status: next.status,
    }, at);
    return { paymentId: ref.id, periodEnd: period.end };
  });
}

/** Marks a payment as void (e.g. a bounced cheque). Dates are corrected separately. */
export async function voidPayment({ db, now }: Deps, actor: Actor, input: z.infer<typeof VoidPaymentInput>): Promise<void> {
  requirePlatform(actor, 'billing.override');
  const at = now();
  const ref = db.doc(paths.payment(input.orgId, input.paymentId));
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const payment = (await tx.get(ref)).data() as PaymentDoc | undefined;
    if (!payment) throw new HttpsError('not-found', 'Payment not found.');
    if (payment.voided) throw new HttpsError('failed-precondition', 'This payment is already void.');
    tx.update(ref, { voided: { by: actor.uid, at, reason: input.reason } });
    auditBilling(audit, actor, input.orgId, 'billing.payment.voided', input.reason, { paymentId: input.paymentId, amountMinor: payment.amountMinor }, at);
  });
}

/** Extends or shortens the trial or the paid period (goodwill, corrections, bounced payments). */
export async function adjustBillingDates({ db, now }: Deps, actor: Actor, input: z.infer<typeof AdjustBillingDatesInput>): Promise<SubscriptionDoc> {
  requirePlatform(actor, 'billing.override');
  const at = now();
  return auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const sub = await readSubscription(tx, db, input.orgId);
    const next = writeSubscription(
      tx,
      db,
      input.orgId,
      {
        ...sub,
        ...(input.trialEndsAt !== undefined ? { trialEndsAt: input.trialEndsAt } : {}),
        ...(input.currentPeriodEnd !== undefined
          ? { currentPeriodEnd: input.currentPeriodEnd, currentPeriodStart: input.currentPeriodEnd === null ? null : (sub.currentPeriodStart ?? at) }
          : {}),
        updatedAt: at,
        updatedBy: actor.uid,
      },
      at,
    );
    notifyStatusChange(tx, db, input.orgId, sub.status, next.status, at);
    auditBilling(audit, actor, input.orgId, 'billing.dates.adjusted', input.reason, {
      from: { trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd },
      to: { trialEndsAt: next.trialEndsAt, currentPeriodEnd: next.currentPeriodEnd },
      status: next.status,
    }, at);
    return next;
  });
}

/** Cancel at the end of the paid period, or undo that. */
export async function setCancellation({ db, now }: Deps, actor: Actor, input: z.infer<typeof SetCancellationInput>): Promise<SubscriptionDoc> {
  requirePlatform(actor, 'billing.override');
  const at = now();
  return auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const sub = await readSubscription(tx, db, input.orgId);
    const next = writeSubscription(tx, db, input.orgId, { ...sub, cancelAtPeriodEnd: input.cancelAtPeriodEnd, updatedAt: at, updatedBy: actor.uid }, at);
    notifyStatusChange(tx, db, input.orgId, sub.status, next.status, at);
    auditBilling(audit, actor, input.orgId, input.cancelAtPeriodEnd ? 'billing.cancel.scheduled' : 'billing.cancel.undone', input.reason, { status: next.status }, at);
    return next;
  });
}

/** Customer: ask WallX billing for a change (more screens, other plan, renewal, cancellation). */
export async function requestBillingChange({ db, now }: Deps, actor: Actor, input: z.infer<typeof RequestBillingChangeInput>): Promise<{ requestId: string }> {
  const at = now();
  const ref = db.collection(paths.billingRequests(input.orgId)).doc();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'billing.manage');
    const org = (await tx.get(db.doc(paths.org(input.orgId)))).data() as OrgDoc | undefined;
    if (!org || ['pending', 'info_requested', 'rejected'].includes(org.status)) {
      throw new HttpsError('failed-precondition', 'Billing requests are available once the organization is approved.');
    }
    if (input.planId) await readPlan(tx, db, input.planId);
    const open = await tx.get(db.collection(paths.billingRequests(input.orgId)).where('status', '==', 'open').count());
    if (open.data().count >= 5) throw new HttpsError('resource-exhausted', 'You already have 5 open requests. Wait for WallX to handle them.');
    const doc: BillingRequestDoc = {
      id: ref.id,
      orgId: input.orgId,
      orgName: org.name,
      kind: input.kind,
      planId: input.planId ?? null,
      interval: input.interval ?? null,
      quantity: input.quantity ?? null,
      message: input.message,
      status: 'open',
      requestedBy: actor.uid,
      requestedByEmail: actor.email,
      createdAt: at,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    };
    tx.create(ref, doc);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'billing.request.created',
      target: { type: 'billingRequest', id: ref.id },
      data: { kind: input.kind, planId: doc.planId, quantity: doc.quantity },
    });
  });
  return { requestId: ref.id };
}

/** Billing staff: close a customer request (after making the change, or declining it). */
export async function resolveBillingRequest({ db, now }: Deps, actor: Actor, input: z.infer<typeof ResolveBillingRequestInput>): Promise<void> {
  requirePlatform(actor, 'billing.override');
  const at = now();
  const ref = db.doc(paths.billingRequest(input.orgId, input.requestId));
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const req = (await tx.get(ref)).data() as BillingRequestDoc | undefined;
    if (!req) throw new HttpsError('not-found', 'Request not found.');
    if (req.status !== 'open') throw new HttpsError('failed-precondition', 'This request is already closed.');
    tx.update(ref, { status: input.status, resolvedBy: actor.uid, resolvedAt: at, resolutionNote: input.note || null });
    notify(tx, db, input.orgId, 'billing_request_resolved', { kind: req.kind, status: input.status }, '/billing', at);
    audit(input.orgId, {
      at,
      ...platformAudit(actor),
      orgId: input.orgId,
      action: `billing.request.${input.status}`,
      target: { type: 'billingRequest', id: input.requestId },
      ...(input.note ? { reason: input.note } : {}),
    });
  });
}

/** Subscription for a newly approved organization (trial on the trial plan). */
export function trialSubscription(planId: string, trialDays: number, quantity: number, at: number, by: string): SubscriptionDoc {
  return {
    planId,
    status: 'trialing',
    interval: 'monthly',
    quantity,
    customPriceMinor: null,
    discountBps: 0,
    amountPerPeriodMinor: null,
    trialEndsAt: at + trialDays * 86_400_000,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    gateway: 'manual',
    nextTransitionAt: null,
    reminders: [],
    lastPaymentAt: null,
    updatedAt: at,
    updatedBy: by,
  };
}

/**
 * Superadmin, once after deploying phase 6: rewrites subscriptions still in the old shape
 * (planId/status/trialEndsAt only) into the full shape and adds the org billing summary, so
 * the monitor and restricted mode apply to them. Returns how many were upgraded.
 */
export async function migrateSubscriptions({ db, now }: Deps, actor: Actor): Promise<{ migrated: number }> {
  requirePlatform(actor, 'settings.edit');
  const at = now();
  const legacy = (await db.collectionGroup('billing').get()).docs.filter((d) => d.id === 'subscription' && isLegacySubscription(d.data()));
  let migrated = 0;
  for (const doc of legacy) {
    const orgId = doc.ref.parent.parent!.id;
    await auditedTransaction(db, [orgId], async (tx, audit) => {
      const raw = (await tx.get(doc.ref)).data() as SubscriptionDoc | undefined;
      if (!raw || !isLegacySubscription(raw)) return;
      const plan = (await tx.get(db.doc(paths.plan(raw.planId)))).data() as Plan | undefined;
      const sub = normalizeSubscription({ ...raw, updatedBy: actor.uid, updatedAt: at }, plan?.limits.screens ?? 1);
      sub.amountPerPeriodMinor = plan && sub.status !== 'trialing' ? periodAmount(plan, sub) : null;
      const next = writeSubscription(tx, db, orgId, sub, at);
      audit(orgId, {
        at,
        ...platformAudit(actor),
        orgId,
        action: 'billing.subscription.migrated',
        target: { type: 'subscription', id: orgId },
        data: { status: next.status, planId: next.planId },
      });
      migrated++;
    });
  }
  return { migrated };
}
