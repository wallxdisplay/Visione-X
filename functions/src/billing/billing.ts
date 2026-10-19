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
  appsBasePriceMinor,
  billLines,
  billTotalMinor,
  billingState,
  lineProblems,
  linesForPlanFeatures,
  type AppDoc,
  type AppLine,
  type BillLine,
  type EntitlementsDoc,
  type MoveToAppPricingInput,
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
import { entitlementsForSub } from '../lib/entitlements';
import { notify } from '../lib/notify';
import { syncAndRepublish } from '../screens/screenApps';

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
  resellerBilled: !!sub.billedTo,
});

/**
 * App pricing: every app is free in the trial, so starting or ending it changes what the
 * organization may use. Returns the entitlements to write with `draft`, or null when nothing
 * changes. Reads only: call it before the transaction's first write.
 */
export async function trialEntitlements(tx: Transaction, db: Firestore, orgId: string, before: Pick<SubscriptionDoc, 'status'>, draft: SubscriptionDoc, now: number): Promise<EntitlementsDoc | null> {
  if (draft.pricing !== 'apps') return null;
  const status = billingState(draft, now).status;
  if ((before.status === 'trialing') === (status === 'trialing')) return null;
  return entitlementsForSub(tx, db, orgId, { ...draft, status }, now);
}

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

/** The app catalog (reads only). */
export async function readAppCatalog(tx: Transaction, db: Firestore): Promise<AppDoc[]> {
  return (await tx.get(db.collection(paths.apps()))).docs.map((d) => d.data() as AppDoc);
}

/** Bill lines of an app-priced subscription (monthly, before discounts). */
export function subscriptionLines(plan: Plan, sub: SubscriptionDoc, catalog: AppDoc[]): BillLine[] {
  return billLines({
    screens: sub.quantity,
    basePriceMinor: appsBasePriceMinor(plan, catalog.find((a) => a.base), sub.customPriceMinor),
    lines: sub.apps ?? [],
    adjustmentMinor: sub.adjustmentMinor ?? 0,
    catalog,
  });
}

/** Price per billing period before GST in either pricing mode. */
export function subscriptionAmount(plan: Plan, sub: SubscriptionDoc, catalog: AppDoc[]): number | null {
  if (sub.pricing !== 'apps') return periodAmount(plan, sub);
  return subscriptionAmountMinor({
    pricePerScreenMonthlyMinor: billTotalMinor(subscriptionLines(plan, sub, catalog)),
    screens: 1,
    interval: sub.interval,
    annualDiscountBps: plan.annualDiscountBps,
    extraDiscountBps: sub.discountBps,
  });
}

/**
 * Turns requested lines into priced lines. A line already owned keeps its locked price (unless
 * repricing); a new one takes today's catalog price. Lines at quantity 0 are dropped.
 */
export function priceLines(requested: Array<{ appId: string; quantity: number }>, existing: AppLine[], catalog: AppDoc[], at: number, reprice = false): AppLine[] {
  return requested
    .filter((r) => r.quantity > 0)
    .map((r) => {
      const had = existing.find((l) => l.appId === r.appId);
      const app = catalog.find((a) => a.id === r.appId);
      if (had && !reprice) return { ...had, quantity: r.quantity };
      return { appId: r.appId, quantity: r.quantity, unitPriceMinor: app?.priceMinor ?? had?.unitPriceMinor ?? 0, addedAt: had?.addedAt ?? at };
    });
}

/** Refuses lines that do not fit the catalog, the screens bought or the sensor devices in use (reads only). */
export async function checkLines(tx: Transaction, db: Firestore, orgId: string, lines: AppLine[], catalog: AppDoc[], screens: number, owned: string[]) {
  const problems = lineProblems(lines, catalog, screens, owned);
  if (problems.length) throw new HttpsError('invalid-argument', problems[0]!);
  const devicesBought = lines.filter((l) => catalog.find((a) => a.id === l.appId)?.unit === 'sensor_device').reduce((s, l) => s + l.quantity, 0);
  const devices = (await tx.get(db.collection(paths.sensorDevices(orgId)).count())).data().count;
  if (devices > devicesBought) {
    throw new HttpsError('failed-precondition', `The organization has ${devices} sensor devices; buy at least ${devices} or delete some first.`);
  }
}

/** Plan, interval, screens purchased and pricing (billing staff), in plan or app pricing. */
export async function updateSubscription(deps: Deps, actor: Actor, input: z.infer<typeof UpdateSubscriptionInput>): Promise<SubscriptionDoc> {
  const { db, now } = deps;
  requirePlatform(actor, 'billing.override');
  const at = now();
  return afterSeats(deps, input.orgId, auditedTransaction(db, [input.orgId], async (tx, audit) => {
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
    const pricing = input.pricing ?? sub.pricing ?? 'plan';
    const catalog = pricing === 'apps' ? await readAppCatalog(tx, db) : [];
    const lines = pricing === 'apps' ? priceLines(input.apps ?? (sub.apps ?? []), sub.apps ?? [], catalog, at, input.repriceApps ?? false) : [];
    if (pricing === 'apps') await checkLines(tx, db, input.orgId, lines, catalog, input.quantity, (sub.apps ?? []).map((l) => l.appId));
    const draft: SubscriptionDoc = {
      ...sub,
      planId: plan.id,
      interval: input.interval,
      quantity: input.quantity,
      customPriceMinor: input.customPriceMinor,
      discountBps: input.discountBps,
      pricing,
      apps: lines,
      adjustmentMinor: pricing === 'apps' ? (input.adjustmentMinor ?? sub.adjustmentMinor ?? 0) : 0,
      amountPerPeriodMinor: null,
      updatedAt: at,
      updatedBy: actor.uid,
    };
    draft.amountPerPeriodMinor = subscriptionAmount(plan, draft, catalog);
    const entitlements = await entitlementsForSub(tx, db, input.orgId, draft, at);
    const next = writeSubscription(tx, db, input.orgId, draft, at);
    tx.set(db.doc(paths.orgEntitlements(input.orgId)), entitlements);
    notifyStatusChange(tx, db, input.orgId, sub.status, next.status, at);
    auditBilling(audit, actor, input.orgId, 'billing.subscription.updated', input.reason, {
      from: { planId: sub.planId, interval: sub.interval, quantity: sub.quantity, customPriceMinor: sub.customPriceMinor, discountBps: sub.discountBps, pricing: sub.pricing, apps: sub.apps, adjustmentMinor: sub.adjustmentMinor },
      to: { planId: plan.id, interval: input.interval, quantity: input.quantity, customPriceMinor: input.customPriceMinor, discountBps: input.discountBps, pricing, apps: lines, adjustmentMinor: draft.adjustmentMinor },
    }, at);
    return next;
  }));
}

/** After a change to seats or the trial: screens' apps follow (and their content, if it changed). */
export async function afterSeats<T>(deps: Deps, orgId: string, work: Promise<T>): Promise<T> {
  const result = await work;
  await syncAndRepublish(deps, orgId);
  return result;
}

/**
 * Staff: moves a plan-priced organization to app pricing with the same features (the apps its
 * plan included) and, for a paying customer, an adjustment that keeps today's monthly price
 * (grandfathered). With `apply: false` only returns the preview.
 */
export async function moveToAppPricing(
  deps: Deps,
  actor: Actor,
  input: z.infer<typeof MoveToAppPricingInput>,
): Promise<{ lines: BillLine[]; oldMonthlyMinor: number | null; newMonthlyMinor: number; adjustmentMinor: number; applied: boolean }> {
  const { db, now } = deps;
  requirePlatform(actor, 'billing.override');
  const at = now();
  return afterSeats(deps, input.orgId, auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await getOrg(tx, db, input.orgId);
    const sub = await readSubscription(tx, db, input.orgId);
    if (sub.pricing === 'apps') throw new HttpsError('failed-precondition', 'This organization already uses app pricing.');
    const plan = await readPlan(tx, db, sub.planId);
    const catalog = await readAppCatalog(tx, db);
    if (!catalog.some((a) => a.base)) throw new HttpsError('failed-precondition', 'Set up the app catalog first (Admin → App catalog).');
    const devices = (await tx.get(db.collection(paths.sensorDevices(input.orgId)).count())).data().count;
    const lines = linesForPlanFeatures(plan.featureKeys, catalog, sub.quantity, devices, at);
    const trialing = sub.status === 'trialing' && sub.currentPeriodEnd === null;
    // What the customer pays per month today (before the annual / extra discounts, applied again after).
    const planPrice = sub.customPriceMinor ?? plan.pricePerScreenMonthlyMinor;
    const oldMonthlyMinor = trialing || planPrice === null ? null : planPrice * sub.quantity;
    const draft: SubscriptionDoc = { ...sub, pricing: 'apps', apps: lines, adjustmentMinor: 0, customPriceMinor: null };
    const newMonthlyMinor = billTotalMinor(subscriptionLines(plan, draft, catalog));
    const adjustmentMinor = oldMonthlyMinor === null ? 0 : oldMonthlyMinor - newMonthlyMinor;
    draft.adjustmentMinor = adjustmentMinor;
    const preview = { lines: subscriptionLines(plan, draft, catalog), oldMonthlyMinor, newMonthlyMinor, adjustmentMinor };
    if (!input.apply) return { ...preview, applied: false };
    if (!input.reason || input.reason.trim().length < 5) throw new HttpsError('invalid-argument', 'Give a reason of at least 5 characters.');
    draft.amountPerPeriodMinor = trialing ? null : subscriptionAmount(plan, draft, catalog);
    draft.updatedAt = at;
    draft.updatedBy = actor.uid;
    const entitlements = await entitlementsForSub(tx, db, input.orgId, draft, at);
    writeSubscription(tx, db, input.orgId, draft, at);
    tx.set(db.doc(paths.orgEntitlements(input.orgId)), entitlements);
    auditBilling(audit, actor, input.orgId, 'billing.pricing.movedToApps', input.reason, { apps: lines, adjustmentMinor, oldMonthlyMinor, newMonthlyMinor }, at);
    return { ...preview, applied: true };
  }));
}

/** Records a payment received outside the app and extends the paid period. */
export async function recordPayment(deps: Deps, actor: Actor, input: z.infer<typeof RecordPaymentInput>): Promise<{ paymentId: string; periodEnd: number }> {
  const { db, now } = deps;
  requirePlatform(actor, 'billing.override');
  const at = now();
  if (input.paidAt > at + 86_400_000) throw new HttpsError('invalid-argument', 'The payment date is in the future.');
  const ref = db.collection(paths.payments(input.orgId)).doc();
  return afterSeats(deps, input.orgId, auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await getOrg(tx, db, input.orgId);
    const sub = await readSubscription(tx, db, input.orgId);
    if (sub.billedTo) throw new HttpsError('failed-precondition', 'A reseller pays for this organization. Record the payment on the reseller account.');
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
    const paid: SubscriptionDoc = {
      ...sub,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      // Paying ends the trial; the paid period takes over.
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      lastPaymentAt: input.paidAt,
      updatedAt: at,
      updatedBy: actor.uid,
    };
    const entitlements = await trialEntitlements(tx, db, input.orgId, sub, paid, at);
    tx.create(ref, payment);
    const next = writeSubscription(tx, db, input.orgId, paid, at);
    if (entitlements) tx.set(db.doc(paths.orgEntitlements(input.orgId)), entitlements);
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
  }));
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
export async function adjustBillingDates(deps: Deps, actor: Actor, input: z.infer<typeof AdjustBillingDatesInput>): Promise<SubscriptionDoc> {
  const { db, now } = deps;
  requirePlatform(actor, 'billing.override');
  const at = now();
  return afterSeats(deps, input.orgId, auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const sub = await readSubscription(tx, db, input.orgId);
    const adjusted: SubscriptionDoc = {
      ...sub,
      ...(input.trialEndsAt !== undefined ? { trialEndsAt: input.trialEndsAt } : {}),
      ...(input.currentPeriodEnd !== undefined
        ? { currentPeriodEnd: input.currentPeriodEnd, currentPeriodStart: input.currentPeriodEnd === null ? null : (sub.currentPeriodStart ?? at) }
        : {}),
      updatedAt: at,
      updatedBy: actor.uid,
    };
    const entitlements = await trialEntitlements(tx, db, input.orgId, sub, adjusted, at);
    const next = writeSubscription(tx, db, input.orgId, adjusted, at);
    if (entitlements) tx.set(db.doc(paths.orgEntitlements(input.orgId)), entitlements);
    notifyStatusChange(tx, db, input.orgId, sub.status, next.status, at);
    auditBilling(audit, actor, input.orgId, 'billing.dates.adjusted', input.reason, {
      from: { trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd },
      to: { trialEndsAt: next.trialEndsAt, currentPeriodEnd: next.currentPeriodEnd },
      status: next.status,
    }, at);
    return next;
  }));
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
    const current = await readSubscription(tx, db, input.orgId);
    if (current.billedTo) {
      const account = (await tx.get(db.doc(paths.account(current.billedTo)))).data() as { name?: string } | undefined;
      throw new HttpsError('failed-precondition', `Your plan is provided by ${account?.name ?? 'your reseller'}. Contact them for changes.`);
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
export function trialSubscription(planId: string, trialDays: number, quantity: number, at: number, by: string, pricing: 'plan' | 'apps' = 'plan'): SubscriptionDoc {
  return {
    planId,
    pricing,
    apps: [],
    adjustmentMinor: 0,
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
