/**
 * Request schemas for callable Cloud Functions. The web app validates forms with the same
 * schemas, but the server always re-validates: client validation is UX only.
 */
import { z } from 'zod';
import { MAX_SITE_SCOPE, ORG_PERMISSIONS, SYSTEM_ORG_ROLES } from './permissions';
import { PLATFORM_ROLES } from './permissions';
import { GSTIN } from './schemas';

export const Timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone');

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** Indian state/UT GST codes 01–38 plus 97 (other territory). */
export const StateCode = z.string().regex(/^(0[1-9]|[12][0-9]|3[0-8]|97)$/, 'Invalid state code');

export const OrgSignupDetails = z.object({
  orgName: trimmed(2, 120),
  contactName: trimmed(2, 80),
  phone: z.string().trim().regex(/^\+?[0-9][0-9\s-]{7,15}$/, 'Invalid phone number'),
  city: trimmed(2, 80),
  stateCode: StateCode,
  expectedScreens: z.coerce.number().int().min(1).max(100_000),
  gstin: z
    .union([GSTIN, z.literal('')])
    .optional()
    .transform((v) => (v ? v : undefined)),
  timezone: Timezone,
  notes: z.string().trim().max(1000).optional(),
});
export type OrgSignupDetails = z.infer<typeof OrgSignupDetails>;

export const SubmitOrgSignupInput = OrgSignupDetails;

export const ResubmitOrgSignupInput = z.object({
  requestId: id,
  details: OrgSignupDetails,
  response: trimmed(1, 1000),
});

export const ReviewOrgSignupInput = z
  .object({
    requestId: id,
    decision: z.enum(['approve', 'reject', 'request_info']),
    message: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.decision === 'approve' || (v.message && v.message.length >= 5), {
    message: 'A reason of at least 5 characters is required',
    path: ['message'],
  });

export const SetOrgStatusInput = z.object({
  orgId: id,
  action: z.enum(['suspend', 'reactivate']),
  reason: trimmed(5, 500),
});

export const UpdateOrgSettingsInput = z.object({
  orgId: id,
  name: trimmed(2, 120),
  timezone: Timezone,
  requirePublishApproval: z.boolean().optional(),
  emailNotifications: z.boolean().optional(),
});

export const InvitableRole = z.enum(SYSTEM_ORG_ROLES);

/** Sites a member is limited to; empty = all sites. */
const SiteScope = z.array(id).max(MAX_SITE_SCOPE).default([]);

/** A system role, or 'custom' with the org role to give. */
const MemberRole = z.union([InvitableRole, z.literal('custom')]);
const roleChoice = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({ ...shape, role: MemberRole, customRoleId: id.optional() })
    .refine((v) => (v.role === 'custom') === !!v.customRoleId, { path: ['customRoleId'], message: 'Choose a custom role' });

export const InviteMemberInput = roleChoice({
  orgId: id,
  email: z.string().trim().toLowerCase().email(),
  siteScope: SiteScope,
});

export const SetMemberSitesInput = z.object({ orgId: id, uid: id, siteScope: SiteScope });

export const AcceptInviteInput = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
});

export const RevokeInviteInput = z.object({ orgId: id, inviteId: id });

export const UpdateMemberRoleInput = roleChoice({ orgId: id, uid: id });

export const SaveRoleInput = z.object({
  orgId: id,
  roleId: id.optional(),
  name: trimmed(2, 40),
  description: z.string().trim().max(200).default(''),
  permissions: z.array(z.enum(ORG_PERMISSIONS)).min(1).max(ORG_PERMISSIONS.length),
});

export const DeleteRoleInput = z.object({ orgId: id, roleId: id });

export const RemoveMemberInput = z.object({ orgId: id, uid: id });

export const UpsertSiteInput = z.object({
  orgId: id,
  siteId: id.optional(),
  name: trimmed(1, 80),
  address: z.string().trim().max(300).optional(),
  timezone: Timezone,
});

export const DeleteSiteInput = z.object({ orgId: id, siteId: id });

export const SetPlatformRoleInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(PLATFORM_ROLES).nullable(),
});

/** Names of callable functions, shared so the client cannot drift from the server. */
export const CALLABLES = {
  submitOrgSignup: 'submitOrgSignup',
  resubmitOrgSignup: 'resubmitOrgSignup',
  reviewOrgSignup: 'reviewOrgSignup',
  setOrgStatus: 'setOrgStatus',
  updateOrgSettings: 'updateOrgSettings',
  inviteMember: 'inviteMember',
  acceptInvite: 'acceptInvite',
  revokeInvite: 'revokeInvite',
  updateMemberRole: 'updateMemberRole',
  removeMember: 'removeMember',
  upsertSite: 'upsertSite',
  deleteSite: 'deleteSite',
  setPlatformRole: 'setPlatformRole',
  createMediaUpload: 'createMediaUpload',
  updateMedia: 'updateMedia',
  deleteMedia: 'deleteMedia',
  upsertFolder: 'upsertFolder',
  deleteFolder: 'deleteFolder',
  saveLayout: 'saveLayout',
  deleteLayout: 'deleteLayout',
  savePlaylist: 'savePlaylist',
  deletePlaylist: 'deletePlaylist',
  upsertScreenGroup: 'upsertScreenGroup',
  deleteScreenGroup: 'deleteScreenGroup',
  saveSchedule: 'saveSchedule',
  deleteSchedule: 'deleteSchedule',
  claimDevice: 'claimDevice',
  authorizeScreen: 'authorizeScreen',
  updateScreen: 'updateScreen',
  removeScreen: 'removeScreen',
  publishScreens: 'publishScreens',
  triggerEmergency: 'triggerEmergency',
  endEmergency: 'endEmergency',
  sendScreenCommand: 'sendScreenCommand',
  markNotificationsRead: 'markNotificationsRead',
  reviewPublish: 'reviewPublish',
  saveSensorDevice: 'saveSensorDevice',
  rotateSensorKey: 'rotateSensorKey',
  deleteSensorDevice: 'deleteSensorDevice',
  saveSensorChannel: 'saveSensorChannel',
  deleteSensorChannel: 'deleteSensorChannel',
  acknowledgeAlert: 'acknowledgeAlert',
  updateSubscription: 'updateSubscription',
  recordPayment: 'recordPayment',
  voidPayment: 'voidPayment',
  adjustBillingDates: 'adjustBillingDates',
  setCancellation: 'setCancellation',
  requestBillingChange: 'requestBillingChange',
  resolveBillingRequest: 'resolveBillingRequest',
  savePlan: 'savePlan',
  setFeatureRelease: 'setFeatureRelease',
  setEntitlementOverrides: 'setEntitlementOverrides',
  migrateSubscriptions: 'migrateSubscriptions',
  saveDataSource: 'saveDataSource',
  deleteDataSource: 'deleteDataSource',
  geocodePlace: 'geocodePlace',
  testRssFeed: 'testRssFeed',
  previewDataSource: 'previewDataSource',
  playbackReport: 'playbackReport',
  screenAnalytics: 'screenAnalytics',
  createApiKey: 'createApiKey',
  revokeApiKey: 'revokeApiKey',
  saveWebhook: 'saveWebhook',
  deleteWebhook: 'deleteWebhook',
  rotateWebhookSecret: 'rotateWebhookSecret',
  testWebhook: 'testWebhook',
  apiOverview: 'apiOverview',
  saveSyncGroup: 'saveSyncGroup',
  deleteSyncGroup: 'deleteSyncGroup',
  saveMqttBroker: 'saveMqttBroker',
  inviteAccountMember: 'inviteAccountMember',
  revokeAccountInvite: 'revokeAccountInvite',
  removeAccountMember: 'removeAccountMember',
  createPartnerOrg: 'createPartnerOrg',
  setPartnerSubscription: 'setPartnerSubscription',
  startPartnerBilling: 'startPartnerBilling',
  partnerOverview: 'partnerOverview',
  recordAccountPayment: 'recordAccountPayment',
  voidAccountPayment: 'voidAccountPayment',
  setAccountPaidThrough: 'setAccountPaidThrough',
  setPartnerAccess: 'setPartnerAccess',
  deleteMqttBroker: 'deleteMqttBroker',
  setMemberSites: 'setMemberSites',
  saveRole: 'saveRole',
  deleteRole: 'deleteRole',
  createPlayerReleaseUpload: 'createPlayerReleaseUpload',
  registerPlayerRelease: 'registerPlayerRelease',
  setPlayerRollout: 'setPlayerRollout',
  updatePlatformSettings: 'updatePlatformSettings',
  grantSupportAccess: 'grantSupportAccess',
  requestSupportAccess: 'requestSupportAccess',
  emergencySupportAccess: 'emergencySupportAccess',
  respondSupportRequest: 'respondSupportRequest',
  revokeSupportAccess: 'revokeSupportAccess',
  openSupportAccess: 'openSupportAccess',
  saveAccount: 'saveAccount',
  setOrgAccount: 'setOrgAccount',
} as const;
