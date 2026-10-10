/** Single source of truth for Firestore paths (must match firestore.rules). */
export const paths = {
  platformSettings: () => 'platform/settings',
  featureCatalog: () => 'platform/featureCatalog',
  platformUser: (uid: string) => `platformUsers/${uid}`,
  plan: (planId: string) => `plans/${planId}`,
  org: (orgId: string) => `orgs/${orgId}`,
  orgEntitlements: (orgId: string) => `orgs/${orgId}/entitlements/current`,
  orgUsage: (orgId: string) => `orgs/${orgId}/usage/current`,
  member: (orgId: string, uid: string) => `orgs/${orgId}/members/${uid}`,
  site: (orgId: string, siteId: string) => `orgs/${orgId}/sites/${siteId}`,
  screen: (orgId: string, screenId: string) => `orgs/${orgId}/screens/${screenId}`,
  device: (deviceId: string) => `devices/${deviceId}`,
  signupRequest: (id: string) => `signupRequests/${id}`,
  auditLog: (id: string) => `auditLogs/${id}`,
} as const;
