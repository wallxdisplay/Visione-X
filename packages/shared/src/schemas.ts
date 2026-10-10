import { z } from 'zod';
import { FEATURE_KEYS, LIMIT_KEYS, RELEASE_STATUSES } from './features';
import { ORG_PERMISSIONS, PLATFORM_ROLES, SYSTEM_ORG_ROLES } from './permissions';

/** Firestore Timestamps are converted to epoch millis at the boundary. */
const millis = z.number().int().nonnegative();

export const OrgStatus = z.enum(['pending', 'info_requested', 'active', 'suspended', 'rejected']);
export type OrgStatus = z.infer<typeof OrgStatus>;

export const GSTIN = z
  .string()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');

export const BillingProfile = z.object({
  legalName: z.string().min(1),
  gstin: GSTIN.optional(),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  /** State code (2 digits) decides CGST+SGST vs IGST. */
  stateCode: z.string().regex(/^[0-9]{2}$/),
  postalCode: z.string().regex(/^[1-9][0-9]{5}$/),
  country: z.literal('IN'),
  billingEmail: z.string().email(),
});
export type BillingProfile = z.infer<typeof BillingProfile>;

export const Org = z.object({
  id: z.string(),
  name: z.string().min(2).max(120),
  status: OrgStatus,
  /** Future reseller/dealer account that owns this org. */
  parentAccountId: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  branding: z
    .object({ logoPath: z.string().optional(), primaryColor: z.string().optional() })
    .default({}),
  billingProfile: BillingProfile.optional(),
  createdAt: millis,
  updatedAt: millis,
});
export type Org = z.infer<typeof Org>;

export const Member = z.object({
  uid: z.string(),
  email: z.string().email(),
  displayName: z.string().optional(),
  role: z.union([z.enum(SYSTEM_ORG_ROLES), z.literal('custom')]),
  customRoleId: z.string().optional(),
  customPermissions: z.array(z.enum(ORG_PERMISSIONS)).optional(),
  /** Empty = all sites. */
  siteScope: z.array(z.string()).default([]),
  status: z.enum(['active', 'invited', 'disabled']),
  joinedAt: millis.optional(),
});
export type Member = z.infer<typeof Member>;

export const PlatformUser = z.object({
  uid: z.string(),
  email: z.string().email(),
  platformRole: z.enum(PLATFORM_ROLES),
  mfaEnrolled: z.boolean(),
  active: z.boolean(),
});
export type PlatformUser = z.infer<typeof PlatformUser>;

/** Amounts are integer paise (minor units) to avoid floating point. */
export const Money = z.object({ amountMinor: z.number().int(), currency: z.literal('INR') });

export const Plan = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.enum(['trial', 'starter', 'professional', 'enterprise', 'custom']),
  currency: z.literal('INR'),
  pricePerScreenMonthlyMinor: z.number().int().nonnegative().nullable(),
  /** Annual discount in basis points (1500 = 15%). */
  annualDiscountBps: z.number().int().min(0).max(10000),
  trialDays: z.number().int().nonnegative(),
  limits: z.record(z.enum(LIMIT_KEYS), z.number().int().nonnegative().nullable()),
  featureKeys: z.array(z.enum(FEATURE_KEYS)),
  active: z.boolean(),
  version: z.number().int().positive(),
});
export type Plan = z.infer<typeof Plan>;

export const FeatureCatalogEntry = z.object({
  key: z.enum(FEATURE_KEYS),
  releaseStatus: z.enum(RELEASE_STATUSES),
  category: z.string(),
});

// Screens and devices: see devices.ts.

export const AuditLogEntry = z.object({
  id: z.string(),
  at: millis,
  actorType: z.enum(['user', 'platform_user', 'device', 'system', 'support_session']),
  actorId: z.string(),
  orgId: z.string().nullable(),
  action: z.string(),
  target: z.object({ type: z.string(), id: z.string() }),
  reason: z.string().optional(),
  /** Redacted diff; never secrets. */
  changes: z.record(z.object({ before: z.unknown(), after: z.unknown() })).optional(),
  ip: z.string().optional(),
  prevHash: z.string().nullable(),
  hash: z.string(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;
