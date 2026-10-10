/**
 * Shapes of documents as stored in Firestore (written by Cloud Functions).
 * Times are epoch millis so the same types work in Functions, web and Android.
 */
import type { OrgSignupDetails } from './api';
import type { Entitlements, FeatureOverrides } from './features';
import type { OrgPermission, PlatformRole, SystemOrgRole } from './permissions';
import type { OrgStatus } from './schemas';

export interface UserMembership {
  orgName: string;
  orgStatus: OrgStatus;
  role: SystemOrgRole | 'custom';
}

/** users/{uid} — the client's index of its own organizations. */
export interface UserProfileDoc {
  uid: string;
  email: string;
  memberships: Record<string, UserMembership>;
  updatedAt: number;
}

/** orgs/{orgId} */
export interface OrgDoc {
  id: string;
  name: string;
  status: OrgStatus;
  parentAccountId: string | null;
  timezone: string;
  locale: string;
  signupRequestId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  statusReason?: string;
  settings?: OrgSettings;
}

export interface OrgSettings {
  /** Publishing by members without content.approve becomes an approval request. */
  requirePublishApproval?: boolean;
}

/** orgs/{orgId}/members/{uid}; `permissions` is denormalized so rules can check it. */
export interface MemberDoc {
  uid: string;
  email: string;
  role: SystemOrgRole | 'custom';
  permissions: OrgPermission[];
  siteScope: string[];
  status: 'active' | 'disabled';
  joinedAt: number;
  invitedBy: string | null;
}

/** orgs/{orgId}/invites/{inviteId}; the token itself is never stored, only its hash. */
export interface InviteDoc {
  id: string;
  email: string;
  role: SystemOrgRole;
  tokenHash: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface SignupMessage {
  at: number;
  from: 'requester' | 'admin';
  authorId: string;
  text: string;
}

/** signupRequests/{id} */
export interface SignupRequestDoc {
  id: string;
  orgId: string;
  requestedBy: string;
  requesterEmail: string;
  status: 'pending' | 'info_requested' | 'approved' | 'rejected';
  details: OrgSignupDetails;
  messages: SignupMessage[];
  createdAt: number;
  updatedAt: number;
  decidedBy?: string;
  decidedAt?: number;
}

/** orgs/{orgId}/sites/{siteId} */
export interface SiteDoc {
  id: string;
  name: string;
  address?: string;
  timezone: string;
  createdAt: number;
  updatedAt: number;
}

/** orgs/{orgId}/billing/subscription */
export interface SubscriptionDoc {
  planId: string;
  status: 'trialing' | 'active' | 'past_due' | 'restricted' | 'cancelled';
  trialEndsAt: number | null;
  updatedAt: number;
}

/** orgs/{orgId}/entitlements/current (computed) and /overrides (admin-set). */
export interface EntitlementsDoc extends Entitlements {
  planId: string;
  computedAt: number;
}
export type EntitlementOverridesDoc = FeatureOverrides;

/** platformUsers/{uid} */
export interface PlatformUserDoc {
  uid: string;
  email: string;
  platformRole: PlatformRole;
  active: boolean;
  updatedAt: number;
  updatedBy: string;
}

/** auditLogs/{id} — append-only, hash-chained per chain (an org id or "platform"). */
export interface AuditDoc {
  chainId: string;
  seq: number;
  at: number;
  actorType: 'user' | 'platform_user' | 'system';
  actorId: string;
  actorEmail?: string;
  orgId: string | null;
  action: string;
  target: { type: string; id: string };
  reason?: string;
  data?: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}
