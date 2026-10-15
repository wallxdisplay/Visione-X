/**
 * Reseller (dealer) accounts: partners who sell WallX Play to their own customers.
 *
 * Wholesale model: a reseller buys screens from WallX at a dealer price and bills its customers
 * itself. Each customer organization it pays for has `subscription.billedTo = accountId`; the
 * reseller sets the plan and the number of screens for those customers in the partner portal,
 * and WallX billing staff record the reseller's payments on the account. A payment extends the
 * account's `paidThrough`, which is copied to every paid (non-trial) customer subscription, so
 * the usual derived billing status (grace, restricted) applies to the customers unchanged.
 *
 * Reseller staff (accounts/{id}/members) manage their customers fully: each gets a "partner"
 * admin member record in every customer organization (MemberDoc.partner), kept in sync by
 * Functions, shown on the customer's Team page and switched off by the customer's owner with
 * `orgs/{id}.partnerAccess = false`. Organizations a reseller creates are approved at once.
 */
import { z } from 'zod';
import { PAYMENT_METHODS, type BillingStatus, type PaymentMethod } from './billing';
import { StateCode, Timezone } from './api';
import { GSTIN, type Plan } from './schemas';

export const ACCOUNT_STATUSES = ['active', 'inactive'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** owner: everything, including the reseller's team; staff: customers and billing view. */
export const ACCOUNT_ROLES = ['owner', 'staff'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** Days after `paidThrough` before the reseller's paid customers are restricted (as for orgs). */
export const ACCOUNT_GRACE_DAYS = 7;
/** Trial a reseller can give a new customer before billing starts. */
export const PARTNER_TRIAL_DAYS = 14;

export interface AccountDoc {
  id: string;
  type: 'reseller';
  name: string;
  contactName: string;
  email: string;
  phone: string;
  city: string;
  gstin: string | null;
  status: AccountStatus;
  /** Staff notes (agreement, region, terms). */
  notes: string;
  /** The reseller's staff can use the partner portal (absent on older accounts: off). */
  portal?: boolean;
  /** Dealer discount off each plan's list price per screen per month, basis points. */
  dealerDiscountBps?: number;
  /** Fixed dealer price per screen per month in paise, by plan id (overrides the discount). */
  dealerPricesMinor?: Record<string, number>;
  /** The reseller has paid WallX through this time (null: nothing paid yet). */
  paidThrough?: number | null;
  lastPaymentAt?: number | null;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

/** accounts/{accountId}/members/{uid} */
export interface AccountMemberDoc {
  uid: string;
  email: string;
  role: AccountRole;
  status: 'active';
  joinedAt: number;
  invitedBy: string | null;
}

/** accounts/{accountId}/invites/{id}; the token is in inviteTokens/{hash} → {accountId, inviteId}. */
export interface AccountInviteDoc {
  id: string;
  email: string;
  role: AccountRole;
  tokenHash: string;
  status: 'pending' | 'accepted' | 'revoked';
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

/** accounts/{accountId}/payments/{id} — the reseller's payment to WallX. */
export interface AccountPaymentDoc {
  id: string;
  amountMinor: number;
  currency: 'INR';
  method: PaymentMethod;
  reference: string;
  externalInvoiceNo: string | null;
  paidAt: number;
  months: number;
  periodStart: number;
  periodEnd: number;
  note: string | null;
  recordedBy: string;
  recordedByEmail: string | null;
  createdAt: number;
  voided: { by: string; at: number; reason: string } | null;
}

/** Entry in users/{uid}.accounts, for the partner portal switcher. */
export interface UserAccountMembership {
  name: string;
  role: AccountRole;
  status: AccountStatus;
  portal: boolean;
}

// ---------------------------------------------------------------- pure rules

/** Dealer price per screen per month in paise for a plan; null when the plan has no price and no deal. */
export function dealerPriceMinor(
  plan: Pick<Plan, 'id' | 'pricePerScreenMonthlyMinor'>,
  account: Pick<AccountDoc, 'dealerDiscountBps' | 'dealerPricesMinor'>,
): number | null {
  const fixed = account.dealerPricesMinor?.[plan.id];
  if (fixed !== undefined) return fixed;
  if (plan.pricePerScreenMonthlyMinor === null) return null;
  return Math.round((plan.pricePerScreenMonthlyMinor * (10_000 - (account.dealerDiscountBps ?? 0))) / 10_000);
}

const DAY_MS = 86_400_000;

/** The reseller's own standing: none (never paid), active, past_due (grace), restricted. */
export function accountBillingStatus(paidThrough: number | null | undefined, now: number): Exclude<BillingStatus, 'trialing' | 'cancelled'> | 'none' {
  if (!paidThrough) return 'none';
  if (now < paidThrough) return 'active';
  if (now < paidThrough + ACCOUNT_GRACE_DAYS * DAY_MS) return 'past_due';
  return 'restricted';
}

// ---------------------------------------------------------------- partner portal data

export interface PartnerCustomer {
  orgId: string;
  name: string;
  status: string;
  planId: string;
  planName: string;
  /** Screens purchased (the customer's screen limit) and screens in use. */
  quantity: number;
  screensUsed: number;
  screensOnline: number;
  billing: { status: BillingStatus; trialEndsAt: number | null; currentPeriodEnd: number | null };
  /** The reseller pays for this customer (wholesale). False: billed by WallX directly. */
  resellerBilled: boolean;
  trialing: boolean;
  /** Dealer price per screen per month, and this customer's monthly amount (0 while in trial). */
  dealerPriceMinor: number | null;
  monthlyMinor: number | null;
  partnerAccess: boolean;
  createdAt: number;
}

/** partnerOverview callable. */
export interface PartnerOverview {
  account: {
    id: string;
    name: string;
    status: AccountStatus;
    portal: boolean;
    paidThrough: number | null;
    billingStatus: ReturnType<typeof accountBillingStatus>;
    dealerDiscountBps: number;
  };
  customers: PartnerCustomer[];
  /** Plans a reseller can sell, with the dealer price. */
  plans: Array<{ id: string; name: string; listPriceMinor: number | null; dealerPriceMinor: number | null; screenLimit: number | null }>;
  /** Sum of the monthly amounts of paid customers (null when a price is missing). */
  monthlyTotalMinor: number | null;
  serverTime: number;
}

// ---------------------------------------------------------------- inputs

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const reason = z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500);
const money = z.number().int().min(0).max(1_000_000_000_00);

export const SaveAccountInput = z.object({
  accountId: id.optional(),
  name: z.string().trim().min(2).max(120),
  contactName: z.string().trim().max(120).default(''),
  email: z.union([z.string().trim().toLowerCase().email().max(200), z.literal('')]).default(''),
  phone: z.string().trim().max(30).default(''),
  city: z.string().trim().max(80).default(''),
  gstin: GSTIN.nullable().default(null),
  status: z.enum(ACCOUNT_STATUSES).default('active'),
  notes: z.string().trim().max(1000).default(''),
  /** Omitted on older clients: unchanged (new accounts: on). */
  portal: z.boolean().optional(),
  dealerDiscountBps: z.number().int().min(0).max(9_000).optional(),
  dealerPricesMinor: z.record(id, money).optional(),
});

/**
 * Assign an organization to a reseller account, or take it back to WallX direct (null).
 * `resellerBilled`: the reseller pays for it (wholesale); otherwise WallX keeps billing it.
 */
export const SetOrgAccountInput = z.object({
  orgId: id,
  accountId: id.nullable(),
  resellerBilled: z.boolean().default(false),
  reason: z.string().trim().min(3).max(300),
});

export const InviteAccountMemberInput = z.object({
  accountId: id,
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(ACCOUNT_ROLES),
});
export const AccountMemberRefInput = z.object({ accountId: id, uid: z.string().min(1).max(128) });
export const AccountInviteRefInput = z.object({ accountId: id, inviteId: id });

export const CreatePartnerOrgInput = z.object({
  accountId: id,
  orgName: z.string().trim().min(2).max(120),
  contactName: z.string().trim().min(2).max(80),
  phone: z.string().trim().regex(/^\+?[0-9][0-9\s-]{7,15}$/, 'Invalid phone number'),
  city: z.string().trim().min(2).max(80),
  stateCode: StateCode,
  timezone: Timezone,
  /** The customer's owner, invited by email (optional: the reseller can run it alone). */
  ownerEmail: z.union([z.string().trim().toLowerCase().email().max(200), z.literal('')]).default(''),
  planId: id,
  quantity: z.number().int().min(1).max(100_000),
  /** Start with a free trial (not billed to the reseller until billing starts). */
  trial: z.boolean().default(true),
});

export const SetPartnerSubscriptionInput = z.object({
  accountId: id,
  orgId: id,
  planId: id,
  quantity: z.number().int().min(1).max(100_000),
});
export const PartnerOrgRefInput = z.object({ accountId: id, orgId: id });
export const PartnerOverviewInput = z.object({ accountId: id });

export const RecordAccountPaymentInput = z.object({
  accountId: id,
  amountMinor: money.refine((v) => v > 0, 'Enter the amount received'),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().min(1, 'Enter the transaction or cheque reference').max(100),
  externalInvoiceNo: z.string().trim().max(60).optional(),
  paidAt: z.number().int().positive(),
  /** Months the payment covers. */
  months: z.number().int().min(1).max(36),
  note: z.string().trim().max(500).optional(),
});
export const VoidAccountPaymentInput = z.object({ accountId: id, paymentId: id, reason });
export const SetAccountPaidThroughInput = z.object({ accountId: id, paidThrough: z.number().int().positive().nullable(), reason });

/** The customer's owner switches the reseller's access on or off. */
export const SetPartnerAccessInput = z.object({ orgId: id, enabled: z.boolean() });
