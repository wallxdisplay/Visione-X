/**
 * Subscriptions and manual payments (phase 6). Payments are recorded by WallX billing staff
 * (bank transfer, UPI, cheque…); tax invoices are issued by a separate invoicing app, so this
 * module stores only an optional reference to the external invoice number.
 *
 * Status is derived from dates, never set by hand:
 *   active      paid period running
 *   trialing    trial running (and no paid period)
 *   past_due    paid period ended, within the grace period
 *   cancelled   cancelled at period end, and the period is over
 *   restricted  trial over without payment, or grace period over
 * Restricted and cancelled organizations keep playing their last published content, but
 * editing and publishing are locked (BILLING_LOCKED_PERMISSIONS).
 */
import { z } from 'zod';
import { FEATURE_KEYS, LIMIT_KEYS, RELEASE_STATUSES } from './features';
import type { OrgPermission } from './permissions';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const reason = z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500);

export const BILLING_STATUSES = ['trialing', 'active', 'past_due', 'restricted', 'cancelled'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];
export const BILLING_INTERVALS = ['monthly', 'annual'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const DAY_MS = 86_400_000;
/** Days after the paid period ends before the organization is restricted. */
export const BILLING_GRACE_DAYS = 7;
/** Reminders: trial ending / renewal due this many days ahead. */
export const TRIAL_REMINDER_DAYS = 3;
export const RENEWAL_REMINDER_DAYS = 7;

/** Writes refused while billing is restricted or cancelled (viewing, emergency, commands stay). */
export const BILLING_LOCKED_PERMISSIONS: readonly OrgPermission[] = [
  'layout.edit',
  'playlist.edit',
  'schedule.edit',
  'media.upload',
  'content.publish',
  'content.approve',
  'screen.manage',
  'device.authorize',
  'sensor.manage',
];

export const isRestricted = (status: BillingStatus) => status === 'restricted' || status === 'cancelled';

/** orgs/{orgId}/billing/subscription — readable with billing.view; written by Functions. */
export interface SubscriptionDoc {
  planId: string;
  status: BillingStatus;
  interval: BillingInterval;
  /** Screens purchased; the screen limit for plans without a fixed limit. */
  quantity: number;
  /** Custom price per screen per month in paise (enterprise / dealer deals); null = plan price. */
  customPriceMinor: number | null;
  /** Extra discount on top of the annual discount, basis points. */
  discountBps: number;
  /** Price per billing period before GST, in paise; null when there is no price (custom plan). */
  amountPerPeriodMinor: number | null;
  trialEndsAt: number | null;
  currentPeriodStart: number | null;
  /** Paid through this time. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  gateway: 'manual';
  /** Reseller account that pays for this organization (wholesale); its paid period is copied here. */
  billedTo?: string | null;
  /** When the status or a reminder next changes (the monitor picks it up then). */
  nextTransitionAt: number | null;
  /** Reminder keys already sent, e.g. "trial:<ms>", "due:<ms>". */
  reminders: string[];
  lastPaymentAt: number | null;
  updatedAt: number;
  updatedBy: string;
}

/** Denormalized on orgs/{orgId}.billing so every member (and the server) sees it cheaply. */
export interface OrgBillingSummary {
  status: BillingStatus;
  restricted: boolean;
  planId: string;
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
  /** A reseller pays for the organization (wholesale): billing questions go to the reseller. */
  resellerBilled?: boolean;
}

/** orgs/{orgId}/payments/{id} — a payment recorded by billing staff. */
export interface PaymentDoc {
  id: string;
  amountMinor: number;
  currency: 'INR';
  method: PaymentMethod;
  reference: string;
  /** Invoice number from the external invoicing app, if known. */
  externalInvoiceNo: string | null;
  paidAt: number;
  /** The paid period this payment extended the subscription to. */
  periodStart: number;
  periodEnd: number;
  note: string | null;
  recordedBy: string;
  recordedByEmail: string | null;
  createdAt: number;
  voided: { by: string; at: number; reason: string } | null;
}

export const BILLING_REQUEST_KINDS = ['add_screens', 'change_plan', 'renew', 'cancel', 'other'] as const;
export type BillingRequestKind = (typeof BILLING_REQUEST_KINDS)[number];

/** orgs/{orgId}/billingRequests/{id} — a customer's request, handled by billing staff. */
export interface BillingRequestDoc {
  id: string;
  orgId: string;
  orgName: string;
  kind: BillingRequestKind;
  planId: string | null;
  interval: BillingInterval | null;
  quantity: number | null;
  message: string;
  status: 'open' | 'done' | 'declined';
  requestedBy: string;
  requestedByEmail: string | null;
  createdAt: number;
  resolvedBy: string | null;
  resolvedAt: number | null;
  resolutionNote: string | null;
}

// ---------------------------------------------------------------- pure rules

/** Adds calendar months in UTC, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

export const intervalMonths = (interval: BillingInterval) => (interval === 'annual' ? 12 : 1);

/**
 * Period a new payment covers: it extends a running (or grace-period) paid period from its
 * end, so paying a few days late does not shift the billing date; otherwise it starts now.
 */
export function paymentPeriod(
  sub: Pick<SubscriptionDoc, 'currentPeriodEnd' | 'interval'>,
  periods: number,
  now: number,
): { start: number; end: number } {
  const end = sub.currentPeriodEnd;
  const start = end !== null && end + BILLING_GRACE_DAYS * DAY_MS > now ? end : now;
  return { start, end: addMonths(start, intervalMonths(sub.interval) * periods) };
}

export type BillingReminder = { kind: 'trial_ending' | 'due_soon'; key: string };

/** Status now, the next instant anything changes, and a reminder that is due (if any). */
export function billingState(
  sub: Pick<SubscriptionDoc, 'trialEndsAt' | 'currentPeriodEnd' | 'cancelAtPeriodEnd' | 'reminders'>,
  now: number,
): { status: BillingStatus; nextTransitionAt: number | null; reminder: BillingReminder | null } {
  const paidEnd = sub.currentPeriodEnd;
  const graceEnd = paidEnd !== null ? paidEnd + BILLING_GRACE_DAYS * DAY_MS : null;
  const trialEnd = sub.trialEndsAt;

  let status: BillingStatus;
  if (paidEnd !== null && now < paidEnd) status = 'active';
  else if (trialEnd !== null && now < trialEnd) status = 'trialing';
  else if (paidEnd !== null && sub.cancelAtPeriodEnd) status = 'cancelled';
  else if (graceEnd !== null && now < graceEnd) status = 'past_due';
  else status = 'restricted';

  const trialKey = trialEnd !== null ? `trial:${trialEnd}` : null;
  const dueKey = paidEnd !== null ? `due:${paidEnd}` : null;
  const trialRemindAt = trialEnd !== null ? trialEnd - TRIAL_REMINDER_DAYS * DAY_MS : null;
  const dueRemindAt = paidEnd !== null && !sub.cancelAtPeriodEnd ? paidEnd - RENEWAL_REMINDER_DAYS * DAY_MS : null;

  let reminder: BillingReminder | null = null;
  if (status === 'trialing' && trialKey && trialRemindAt !== null && now >= trialRemindAt && !sub.reminders.includes(trialKey)) {
    reminder = { kind: 'trial_ending', key: trialKey };
  } else if (status === 'active' && dueKey && dueRemindAt !== null && now >= dueRemindAt && !sub.reminders.includes(dueKey)) {
    reminder = { kind: 'due_soon', key: dueKey };
  }

  const sent = new Set([...sub.reminders, ...(reminder ? [reminder.key] : [])]);
  const candidates = [
    trialKey && !sent.has(trialKey) ? trialRemindAt : null,
    trialEnd,
    dueKey && !sent.has(dueKey) ? dueRemindAt : null,
    paidEnd,
    sub.cancelAtPeriodEnd ? null : graceEnd,
  ].filter((t): t is number => t !== null && t > now);
  return { status, nextTransitionAt: candidates.length ? Math.min(...candidates) : null, reminder };
}

// ---------------------------------------------------------------- callable inputs

const money = z.number().int().min(0).max(1_000_000_000_00);

export const UpdateSubscriptionInput = z.object({
  orgId: id,
  planId: id,
  interval: z.enum(BILLING_INTERVALS),
  quantity: z.number().int().min(1).max(100_000),
  customPriceMinor: money.nullable(),
  discountBps: z.number().int().min(0).max(10_000),
  reason,
});

export const RecordPaymentInput = z.object({
  orgId: id,
  amountMinor: money.refine((v) => v > 0, 'Enter the amount received'),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().min(1, 'Enter the transaction or cheque reference').max(100),
  externalInvoiceNo: z.string().trim().max(60).optional(),
  paidAt: z.number().int().positive(),
  /** Number of billing intervals the payment covers. */
  periods: z.number().int().min(1).max(36),
  note: z.string().trim().max(500).optional(),
});

export const VoidPaymentInput = z.object({ orgId: id, paymentId: id, reason });

export const AdjustBillingDatesInput = z
  .object({
    orgId: id,
    /** Omit to keep; null to clear. */
    trialEndsAt: z.number().int().positive().nullable().optional(),
    currentPeriodEnd: z.number().int().positive().nullable().optional(),
    reason,
  })
  .refine((v) => v.trialEndsAt !== undefined || v.currentPeriodEnd !== undefined, { message: 'Change at least one date', path: ['trialEndsAt'] });

export const SetCancellationInput = z.object({ orgId: id, cancelAtPeriodEnd: z.boolean(), reason });

export const RequestBillingChangeInput = z.object({
  orgId: id,
  kind: z.enum(BILLING_REQUEST_KINDS),
  planId: id.optional(),
  interval: z.enum(BILLING_INTERVALS).optional(),
  quantity: z.number().int().min(1).max(100_000).optional(),
  message: z.string().trim().max(1000),
});

export const ResolveBillingRequestInput = z
  .object({ orgId: id, requestId: id, status: z.enum(['done', 'declined']), note: z.string().trim().max(500).optional() })
  .refine((v) => v.status === 'done' || (v.note && v.note.length >= 5), { message: 'Explain why the request is declined', path: ['note'] });

const LimitsInput = z.object(
  Object.fromEntries(LIMIT_KEYS.map((k) => [k, z.number().int().min(0).max(1_000_000_000).nullable()])) as Record<
    (typeof LIMIT_KEYS)[number],
    z.ZodNullable<z.ZodNumber>
  >,
);

export const SavePlanInput = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/, 'Use 2–40 lowercase letters, digits or -'),
  isNew: z.boolean(),
  name: z.string().trim().min(2).max(60),
  tier: z.enum(['trial', 'starter', 'professional', 'enterprise', 'custom']),
  pricePerScreenMonthlyMinor: money.nullable(),
  annualDiscountBps: z.number().int().min(0).max(10_000),
  trialDays: z.number().int().min(0).max(90),
  limits: LimitsInput,
  featureKeys: z.array(z.enum(FEATURE_KEYS)),
  active: z.boolean(),
  reason,
});

export const SetFeatureReleaseInput = z.object({ key: z.enum(FEATURE_KEYS), releaseStatus: z.enum(RELEASE_STATUSES), reason });

export const SetEntitlementOverridesInput = z.object({
  orgId: id,
  grant: z.array(z.enum(FEATURE_KEYS)),
  revoke: z.array(z.enum(FEATURE_KEYS)),
  /** Only the limits to override; others come from the plan. */
  limits: LimitsInput.partial(),
  reason,
});

/** Rupees with paise for display (₹1,23,456.00 style, Indian grouping). */
export function formatInr(minor: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(minor / 100);
}

/**
 * Fills fields missing on subscriptions written before phase 6 (which had only planId,
 * status, trialEndsAt and updatedAt). Safe on current documents (returns them unchanged).
 */
export function normalizeSubscription(raw: Partial<SubscriptionDoc> & { planId: string }, fallbackQuantity = 1): SubscriptionDoc {
  return {
    planId: raw.planId,
    status: raw.status ?? 'trialing',
    interval: raw.interval ?? 'monthly',
    quantity: raw.quantity ?? fallbackQuantity,
    customPriceMinor: raw.customPriceMinor ?? null,
    discountBps: raw.discountBps ?? 0,
    amountPerPeriodMinor: raw.amountPerPeriodMinor ?? null,
    trialEndsAt: raw.trialEndsAt ?? null,
    currentPeriodStart: raw.currentPeriodStart ?? null,
    currentPeriodEnd: raw.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: raw.cancelAtPeriodEnd ?? false,
    gateway: 'manual',
    billedTo: raw.billedTo ?? null,
    nextTransitionAt: raw.nextTransitionAt ?? null,
    reminders: raw.reminders ?? [],
    lastPaymentAt: raw.lastPaymentAt ?? null,
    updatedAt: raw.updatedAt ?? 0,
    updatedBy: raw.updatedBy ?? 'migration',
  };
}

/** True for subscriptions still in the pre-phase-6 shape. */
export const isLegacySubscription = (raw: Partial<SubscriptionDoc>) => raw.gateway === undefined;
