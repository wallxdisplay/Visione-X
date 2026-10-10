/** Single source of truth for Firestore paths (must match firestore.rules). */
export const paths = {
  platformSettings: () => 'platform/settings',
  featureCatalog: () => 'platform/featureCatalog',
  platformUser: (uid: string) => `platformUsers/${uid}`,
  plan: (planId: string) => `plans/${planId}`,
  userProfile: (uid: string) => `users/${uid}`,
  org: (orgId: string) => `orgs/${orgId}`,
  orgEntitlements: (orgId: string) => `orgs/${orgId}/entitlements/current`,
  orgEntitlementOverrides: (orgId: string) => `orgs/${orgId}/entitlements/overrides`,
  orgSubscription: (orgId: string) => `orgs/${orgId}/billing/subscription`,
  orgUsage: (orgId: string) => `orgs/${orgId}/usage/current`,
  members: (orgId: string) => `orgs/${orgId}/members`,
  member: (orgId: string, uid: string) => `orgs/${orgId}/members/${uid}`,
  invites: (orgId: string) => `orgs/${orgId}/invites`,
  invite: (orgId: string, inviteId: string) => `orgs/${orgId}/invites/${inviteId}`,
  /** Global lookup from token hash → invite, so accepting needs only the token. */
  inviteToken: (tokenHash: string) => `inviteTokens/${tokenHash}`,
  sites: (orgId: string) => `orgs/${orgId}/sites`,
  site: (orgId: string, siteId: string) => `orgs/${orgId}/sites/${siteId}`,
  screen: (orgId: string, screenId: string) => `orgs/${orgId}/screens/${screenId}`,
  device: (deviceId: string) => `devices/${deviceId}`,
  signupRequests: () => 'signupRequests',
  signupRequest: (id: string) => `signupRequests/${id}`,
  auditLogs: () => 'auditLogs',
  auditHead: (chainId: string) => `auditHeads/${chainId}`,
} as const;

export const PLATFORM_AUDIT_CHAIN = 'platform';
export const TRIAL_PLAN_ID = 'trial';
export const TRIAL_DAYS = 14;
export const INVITE_TTL_DAYS = 7;
