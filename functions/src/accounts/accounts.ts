/**
 * Reseller accounts, managed by WallX staff (packages/shared/src/accounts.ts): details, portal
 * access and dealer pricing, which organizations belong to a reseller, and the reseller's
 * wholesale payments, whose paid period is copied to every customer it pays for.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  ACCOUNT_GRACE_DAYS,
  PLATFORM_AUDIT_CHAIN,
  addMonths,
  normalizeSubscription,
  paths,
  type AccountDoc,
  type AccountPaymentDoc,
  type RecordAccountPaymentInput,
  type SaveAccountInput,
  type SetAccountPaidThroughInput,
  type SetOrgAccountInput,
  type SubscriptionDoc,
  type VoidAccountPaymentInput,
} from '@wallx-play/shared';
import { notifyStatusChange, writeSubscription } from '../billing/billing';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { getOrg, requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { fanOutAccountToProfiles, readAccount, syncAccountOrgs, syncPartnerMembers } from './partners';

const DAY_MS = 86_400_000;

export async function saveAccount(deps: Deps, actor: Actor, input: z.infer<typeof SaveAccountInput>): Promise<{ accountId: string }> {
  const { db, now } = deps;
  requirePlatform(actor, 'account.manage');
  const ref = input.accountId ? db.doc(paths.account(input.accountId)) : db.collection(paths.accounts()).doc();
  let accessChanged = false;
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const before = (await tx.get(ref)).data() as AccountDoc | undefined;
    if (input.accountId && !before) throw new HttpsError('not-found', 'Reseller account not found.');
    const at = now();
    const doc: AccountDoc = {
      id: ref.id,
      type: 'reseller',
      name: input.name,
      contactName: input.contactName ?? '',
      email: input.email ?? '',
      phone: input.phone ?? '',
      city: input.city ?? '',
      gstin: input.gstin ?? null,
      status: input.status ?? 'active',
      notes: input.notes ?? '',
      portal: input.portal ?? before?.portal ?? !before,
      dealerDiscountBps: input.dealerDiscountBps ?? before?.dealerDiscountBps ?? 0,
      dealerPricesMinor: input.dealerPricesMinor ?? before?.dealerPricesMinor ?? {},
      paidThrough: before?.paidThrough ?? null,
      lastPaymentAt: before?.lastPaymentAt ?? null,
      createdAt: before?.createdAt ?? at,
      createdBy: before?.createdBy ?? actor.uid,
      updatedAt: at,
      updatedBy: actor.uid,
    };
    accessChanged = !!before && (before.status !== doc.status || (before.portal === true) !== doc.portal || before.name !== doc.name);
    tx.set(ref, doc);
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: before ? 'account.updated' : 'account.created',
      target: { type: 'account', id: ref.id },
      data: {
        name: doc.name,
        status: doc.status,
        portal: doc.portal,
        dealerDiscountBps: doc.dealerDiscountBps,
        dealerPricesMinor: doc.dealerPricesMinor,
        ...(before ? { from: { name: before.name, status: before.status, portal: before.portal ?? false, dealerDiscountBps: before.dealerDiscountBps ?? 0, dealerPricesMinor: before.dealerPricesMinor ?? {} } } : {}),
      },
    });
  });
  // Status, portal or name changed: the team's profiles and their access to customers follow.
  if (accessChanged) {
    await fanOutAccountToProfiles(deps, ref.id);
    await syncAccountOrgs(deps, ref.id);
  }
  return { accountId: ref.id };
}

/** Puts an organization under a reseller account, or back to WallX direct (accountId null). */
export async function setOrgAccount(deps: Deps, actor: Actor, input: z.infer<typeof SetOrgAccountInput>): Promise<void> {
  const { db, now } = deps;
  requirePlatform(actor, 'account.manage');
  const resellerBilled = !!input.accountId && (input.resellerBilled ?? false);
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN, input.orgId], async (tx, audit) => {
    const org = await getOrg(tx, db, input.orgId);
    let account: AccountDoc | undefined;
    if (input.accountId) {
      account = await readAccount(tx, db, input.accountId);
      if (account.status !== 'active') throw new HttpsError('failed-precondition', `“${account.name}” is inactive.`);
    }
    const subSnap = await tx.get(db.doc(paths.orgSubscription(input.orgId)));
    const sub = subSnap.exists ? normalizeSubscription(subSnap.data() as SubscriptionDoc) : null;
    const billedTo = resellerBilled ? input.accountId : null;
    if (org.parentAccountId === input.accountId && (sub?.billedTo ?? null) === billedTo) return;
    const at = now();
    tx.update(db.doc(paths.org(input.orgId)), { parentAccountId: input.accountId, updatedAt: at });
    if (sub && (sub.billedTo ?? null) !== billedTo) {
      // Wholesale: a paid customer takes the reseller's paid period; trials stay as they are.
      const paid = sub.trialEndsAt === null || sub.currentPeriodEnd !== null;
      const next = writeSubscription(
        tx,
        db,
        input.orgId,
        { ...sub, billedTo, ...(billedTo && paid ? { currentPeriodEnd: account!.paidThrough ?? null, trialEndsAt: null } : {}), updatedAt: at, updatedBy: actor.uid },
        at,
      );
      notifyStatusChange(tx, db, input.orgId, sub.status, next.status, at);
    }
    const entry = {
      at,
      ...platformAudit(actor),
      orgId: input.orgId,
      action: 'org.account.changed',
      target: { type: 'org', id: input.orgId },
      reason: input.reason,
      data: { from: org.parentAccountId, to: input.accountId, account: account?.name ?? null, resellerBilled },
    };
    // Recorded for WallX and in the organization's own log.
    audit(PLATFORM_AUDIT_CHAIN, entry);
    audit(input.orgId, entry);
  });
  await syncPartnerMembers(deps, input.orgId);
}

/**
 * Copies the reseller's paid period to every customer it pays for (not those in a trial), so
 * their status follows the reseller's payments. Each customer is its own audited transaction.
 */
export async function propagateAccountBilling({ db, now }: Deps, accountId: string, by: string): Promise<number> {
  const orgs = await db.collection(paths.orgs()).where('parentAccountId', '==', accountId).get();
  let updated = 0;
  for (const o of orgs.docs) {
    await auditedTransaction(db, [o.id], async (tx, audit) => {
      const account = await readAccount(tx, db, accountId);
      const raw = (await tx.get(db.doc(paths.orgSubscription(o.id)))).data() as SubscriptionDoc | undefined;
      if (!raw) return;
      const sub = normalizeSubscription(raw);
      if (sub.billedTo !== accountId || (sub.trialEndsAt !== null && sub.currentPeriodEnd === null)) return;
      const paidThrough = account.paidThrough ?? null;
      if (sub.currentPeriodEnd === paidThrough) return;
      const at = now();
      const next = writeSubscription(tx, db, o.id, { ...sub, currentPeriodEnd: paidThrough, trialEndsAt: null, updatedAt: at, updatedBy: by }, at);
      notifyStatusChange(tx, db, o.id, sub.status, next.status, at);
      audit(o.id, {
        at,
        actorType: 'system',
        actorId: 'reseller-billing',
        orgId: o.id,
        action: 'billing.partner.periodSynced',
        target: { type: 'subscription', id: o.id },
        data: { accountId, from: sub.currentPeriodEnd, to: paidThrough, status: next.status },
      });
      updated++;
    });
  }
  return updated;
}

/** Records the reseller's payment to WallX and extends its paid period (and its customers'). */
export async function recordAccountPayment(deps: Deps, actor: Actor, input: z.infer<typeof RecordAccountPaymentInput>): Promise<{ paymentId: string; paidThrough: number; customersUpdated: number }> {
  const { db, now } = deps;
  requirePlatform(actor, 'billing.override');
  const at = now();
  if (input.paidAt > at + DAY_MS) throw new HttpsError('invalid-argument', 'The payment date is in the future.');
  const ref = db.collection(paths.accountPayments(input.accountId)).doc();
  const paidThrough = await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const account = await readAccount(tx, db, input.accountId);
    // Like an organization's payment: a running (or grace-period) period is extended from its end.
    const end = account.paidThrough ?? null;
    const start = end !== null && end + ACCOUNT_GRACE_DAYS * DAY_MS > at ? end : at;
    const periodEnd = addMonths(start, input.months);
    const payment: AccountPaymentDoc = {
      id: ref.id,
      amountMinor: input.amountMinor,
      currency: 'INR',
      method: input.method,
      reference: input.reference,
      externalInvoiceNo: input.externalInvoiceNo || null,
      paidAt: input.paidAt,
      months: input.months,
      periodStart: start,
      periodEnd,
      note: input.note || null,
      recordedBy: actor.uid,
      recordedByEmail: actor.email,
      createdAt: at,
      voided: null,
    };
    tx.create(ref, payment);
    tx.update(db.doc(paths.account(input.accountId)), { paidThrough: periodEnd, lastPaymentAt: input.paidAt, updatedAt: at, updatedBy: actor.uid });
    audit(PLATFORM_AUDIT_CHAIN, {
      at,
      ...platformAudit(actor),
      orgId: null,
      action: 'account.payment.recorded',
      target: { type: 'account', id: input.accountId },
      data: { paymentId: ref.id, amountMinor: input.amountMinor, method: input.method, reference: input.reference, externalInvoiceNo: input.externalInvoiceNo ?? null, months: input.months, paidThrough: periodEnd },
    });
    return periodEnd;
  });
  const customersUpdated = await propagateAccountBilling(deps, input.accountId, actor.uid);
  return { paymentId: ref.id, paidThrough, customersUpdated };
}

/** Marks a reseller payment void (e.g. a bounced cheque). Correct the paid period separately. */
export async function voidAccountPayment({ db, now }: Deps, actor: Actor, input: z.infer<typeof VoidAccountPaymentInput>): Promise<void> {
  requirePlatform(actor, 'billing.override');
  const ref = db.doc(paths.accountPayment(input.accountId, input.paymentId));
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const payment = (await tx.get(ref)).data() as AccountPaymentDoc | undefined;
    if (!payment) throw new HttpsError('not-found', 'Payment not found.');
    if (payment.voided) throw new HttpsError('failed-precondition', 'This payment is already void.');
    const at = now();
    tx.update(ref, { voided: { by: actor.uid, at, reason: input.reason } });
    audit(PLATFORM_AUDIT_CHAIN, { at, ...platformAudit(actor), orgId: null, action: 'account.payment.voided', target: { type: 'account', id: input.accountId }, reason: input.reason, data: { paymentId: input.paymentId, amountMinor: payment.amountMinor } });
  });
}

/** Sets the reseller's paid-through date (opening balance, goodwill, bounced payment). */
export async function setAccountPaidThrough(deps: Deps, actor: Actor, input: z.infer<typeof SetAccountPaidThroughInput>): Promise<{ customersUpdated: number }> {
  const { db, now } = deps;
  requirePlatform(actor, 'billing.override');
  await auditedTransaction(db, [PLATFORM_AUDIT_CHAIN], async (tx, audit) => {
    const account = await readAccount(tx, db, input.accountId);
    const at = now();
    tx.update(db.doc(paths.account(input.accountId)), { paidThrough: input.paidThrough, updatedAt: at, updatedBy: actor.uid });
    audit(PLATFORM_AUDIT_CHAIN, { at, ...platformAudit(actor), orgId: null, action: 'account.paidThrough.set', target: { type: 'account', id: input.accountId }, reason: input.reason, data: { from: account.paidThrough ?? null, to: input.paidThrough } });
  });
  return { customersUpdated: await propagateAccountBilling(deps, input.accountId, actor.uid) };
}
