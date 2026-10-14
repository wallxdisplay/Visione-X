/**
 * Support access (docs/ARCHITECTURE.md §11–12): WallX support staff get into a customer's
 * organization only through a time-boxed grant that the customer can see and end. A grant is
 * given by the customer, approved by the customer after a staff request, or — in an emergency —
 * granted by a superadmin (audited, customer notified). Staff who open it get a temporary member
 * record (MemberDoc.support) that ends with the grant; it never reveals passwords or secrets
 * (API keys are stored hashed) and never includes team, billing or settings permissions.
 */
import { z } from 'zod';
import { SYSTEM_ORG_ROLE_PERMISSIONS, type OrgPermission } from './permissions';

export const SUPPORT_LEVELS = ['view', 'edit'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

/** View: look around. Edit: also fix content, publish and send screen commands. */
export const SUPPORT_LEVEL_PERMISSIONS: Record<SupportLevel, readonly OrgPermission[]> = {
  view: SYSTEM_ORG_ROLE_PERMISSIONS.viewer,
  edit: [...SYSTEM_ORG_ROLE_PERMISSIONS.editor, 'screen.command'],
};
export const SUPPORT_LEVEL_ROLE = { view: 'viewer', edit: 'editor' } as const;

export const SUPPORT_DURATIONS_HOURS = [1, 4, 24, 72] as const;
export const MAX_SUPPORT_HOURS = 72;

export type SupportGrantStatus = 'requested' | 'active' | 'declined' | 'revoked' | 'expired';

export interface SupportPerson {
  uid: string;
  email: string | null;
}

/** orgs/{orgId}/supportGrants/{grantId} — readable by the org's members and support staff. */
export interface SupportGrantDoc {
  id: string;
  orgId: string;
  status: SupportGrantStatus;
  level: SupportLevel;
  hours: number;
  reason: string;
  /** Who started it: the customer, a staff request, or a superadmin's emergency grant. */
  origin: 'customer' | 'staff_request' | 'emergency';
  requestedBy: SupportPerson | null;
  decidedBy: SupportPerson | null;
  createdAt: number;
  decidedAt: number | null;
  /** Set when it becomes active. */
  expiresAt: number | null;
  endedAt: number | null;
  /** Staff who opened the organization with this grant (their temporary member records). */
  openedBy: string[];
}

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const hours = z.number().int().min(1).max(MAX_SUPPORT_HOURS);
const reason = z.string().trim().max(300);

/** Customer gives access (member.manage). */
export const GrantSupportAccessInput = z.object({ orgId: id, level: z.enum(SUPPORT_LEVELS), hours, reason: reason.default('') });
/** Staff asks for access (support.access.request); the customer approves or declines. */
export const RequestSupportAccessInput = z.object({ orgId: id, level: z.enum(SUPPORT_LEVELS), hours, reason: reason.min(5) });
/** Superadmin emergency grant without customer approval (support.access.grant). */
export const EmergencySupportAccessInput = RequestSupportAccessInput;
export const RespondSupportRequestInput = z.object({ orgId: id, grantId: id, approve: z.boolean() });
export const SupportGrantRefInput = z.object({ orgId: id, grantId: id });

/** True while a grant gives access. */
export const supportGrantActive = (g: Pick<SupportGrantDoc, 'status' | 'expiresAt'>, now: number) =>
  g.status === 'active' && !!g.expiresAt && g.expiresAt > now;
