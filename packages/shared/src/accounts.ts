/**
 * Reseller / dealer accounts (accounts/{accountId}): groundwork for selling through partners.
 * An organization belongs to at most one account (OrgDoc.parentAccountId). Today only WallX
 * staff manage accounts and assignments; a self-service reseller portal (feature
 * "reseller.portal") and dealer pricing come later. Per-screen custom prices already live on
 * each organization's subscription.
 */
import { z } from 'zod';
import { GSTIN } from './schemas';

export const ACCOUNT_STATUSES = ['active', 'inactive'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

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
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
}

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

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
});

/** Assign an organization to a reseller account, or take it back to WallX direct (null). */
export const SetOrgAccountInput = z.object({ orgId: id, accountId: id.nullable(), reason: z.string().trim().min(3).max(300) });
