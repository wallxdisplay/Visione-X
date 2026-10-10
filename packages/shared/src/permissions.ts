/**
 * Permission keys. These strings are stored in Firestore (custom roles) and checked by
 * Cloud Functions and Security Rules, so treat them as a stable public contract.
 */

export const ORG_PERMISSIONS = [
  'org.settings.edit',
  'member.view',
  'member.manage',
  'site.manage',
  'screen.view',
  'screen.manage',
  'screen.command',
  'device.authorize',
  'media.view',
  'media.upload',
  'media.delete',
  'layout.edit',
  'playlist.edit',
  'schedule.edit',
  'content.publish',
  'content.approve',
  'emergency.trigger',
  'sensor.view',
  'sensor.manage',
  'integration.manage',
  'apikey.manage',
  'report.view',
  'billing.view',
  'billing.manage',
  'audit.view',
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const SYSTEM_ORG_ROLES = ['owner', 'admin', 'editor', 'approver', 'viewer'] as const;
export type SystemOrgRole = (typeof SYSTEM_ORG_ROLES)[number];

const VIEW: OrgPermission[] = [
  'member.view',
  'screen.view',
  'media.view',
  'sensor.view',
  'report.view',
];

const EDIT: OrgPermission[] = [
  ...VIEW,
  'media.upload',
  'media.delete',
  'layout.edit',
  'playlist.edit',
  'schedule.edit',
];

export const SYSTEM_ORG_ROLE_PERMISSIONS: Record<SystemOrgRole, readonly OrgPermission[]> = {
  owner: ORG_PERMISSIONS,
  admin: ORG_PERMISSIONS.filter((p) => p !== 'billing.manage'),
  editor: [...EDIT, 'content.publish'],
  approver: [...EDIT, 'content.publish', 'content.approve'],
  viewer: VIEW,
};

export const PLATFORM_ROLES = ['superadmin', 'support', 'billing', 'ops', 'auditor'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_PERMISSIONS = [
  'org.view',
  'org.approve',
  'org.suspend',
  'org.limits.edit',
  'platformUser.manage',
  'plan.manage',
  'billing.view',
  'billing.override',
  'device.view',
  'device.command',
  'support.access.request',
  'support.access.grant',
  'ticket.manage',
  'audit.view',
  'settings.edit',
  'backup.manage',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  superadmin: PLATFORM_PERMISSIONS,
  support: ['org.view', 'device.view', 'support.access.request', 'ticket.manage'],
  billing: ['org.view', 'plan.manage', 'billing.view', 'billing.override'],
  ops: ['org.view', 'device.view', 'device.command', 'ticket.manage'],
  auditor: ['org.view', 'billing.view', 'device.view', 'audit.view'],
};

export interface MemberAccess {
  role: SystemOrgRole | 'custom';
  /** Present when role === 'custom'. */
  customPermissions?: readonly OrgPermission[];
  status: 'active' | 'invited' | 'disabled';
}

export function orgPermissionsFor(member: MemberAccess): ReadonlySet<OrgPermission> {
  if (member.status !== 'active') return new Set();
  if (member.role === 'custom') return new Set(member.customPermissions ?? []);
  return new Set(SYSTEM_ORG_ROLE_PERMISSIONS[member.role]);
}

export function hasOrgPermission(member: MemberAccess, permission: OrgPermission): boolean {
  return orgPermissionsFor(member).has(permission);
}

export function hasPlatformPermission(
  role: PlatformRole | null | undefined,
  permission: PlatformPermission,
): boolean {
  return role ? PLATFORM_ROLE_PERMISSIONS[role].includes(permission) : false;
}
