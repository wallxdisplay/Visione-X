import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { z } from 'zod';
import {
  AcceptInviteInput,
  AcknowledgeAlertInput,
  DataSourceRefInput,
  GeocodeInput,
  SaveDataSourceInput,
  TestRssInput,
  AdjustBillingDatesInput,
  RecordPaymentInput,
  RequestBillingChangeInput,
  ResolveBillingRequestInput,
  SavePlanInput,
  SetCancellationInput,
  SetEntitlementOverridesInput,
  SaveRoleInput,
  CreatePlayerReleaseInput,
  RegisterPlayerReleaseInput,
  SetPlayerRolloutInput,
  UpdatePlatformSettingsInput,
  GrantSupportAccessInput,
  RequestSupportAccessInput,
  EmergencySupportAccessInput,
  RespondSupportRequestInput,
  SupportGrantRefInput,
  SaveAccountInput,
  SetOrgAccountInput,
  DeleteRoleInput,
  SetMemberSitesInput,
  SetFeatureReleaseInput,
  UpdateSubscriptionInput,
  VoidPaymentInput,
  DeleteSensorChannelInput,
  SaveSensorChannelInput,
  SaveSensorDeviceInput,
  SensorDeviceRefInput,
  ClaimDeviceInput,
  EndEmergencyInput,
  MarkNotificationsReadInput,
  PublishScreensInput,
  ReviewPublishInput,
  SendScreenCommandInput,
  TriggerEmergencyInput,
  ScreenRefInput,
  UpdateScreenInput,
  CreateMediaUploadInput,
  DeleteFolderInput,
  DeleteLayoutInput,
  DeleteMediaInput,
  DeletePlaylistInput,
  DeleteScheduleInput,
  DeleteScreenGroupInput,
  SaveLayoutInput,
  SavePlaylistInput,
  SaveScheduleInput,
  UpdateMediaInput,
  UpsertFolderInput,
  UpsertScreenGroupInput,
  DeleteSiteInput,
  InviteMemberInput,
  PLATFORM_ROLES,
  RemoveMemberInput,
  ResubmitOrgSignupInput,
  ReviewOrgSignupInput,
  RevokeInviteInput,
  SetOrgStatusInput,
  SetPlatformRoleInput,
  SubmitOrgSignupInput,
  UpdateMemberRoleInput,
  UpdateOrgSettingsInput,
  UpsertSiteInput,
  type PlatformRole,
} from '@wallx-play/shared';
import { setPlatformRole as setPlatformRoleSvc } from './admin/platformUsers';
import * as layouts from './content/layouts';
import * as media from './content/media';
import * as schedules from './content/schedules';
import { getDeps } from './lib/admin';
import type { Actor, Deps } from './lib/context';
import * as members from './members/members';
import * as roles from './members/roles';
import * as playerReleases from './players/releases';
import * as platformSettings from './platform/settings';
import * as support from './support/access';
import * as accounts from './accounts/accounts';
import { reviewOrgSignup as reviewSvc, setOrgStatus as setOrgStatusSvc } from './orgs/review';
import * as settings from './orgs/settings';
import * as signup from './orgs/signup';
import * as screens from './screens/screens';
import * as commands from './ops/commands';
import * as emergency from './ops/emergency';
import * as sensors from './sensors/sensors';
import * as billing from './billing/billing';
import * as plans from './billing/plans';
import * as integrations from './integrations/dataSources';
import { BASE_OPTIONS, ENFORCE_APP_CHECK, MAIL_SECRETS, WEATHER_SECRETS } from './options';

export function actorFrom(request: CallableRequest): Actor {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in to continue.');
  // Devices authenticate with custom tokens; they may never call user-facing functions.
  if (auth.token.type === 'device') throw new HttpsError('permission-denied', 'Not allowed for devices.');
  const role = auth.token.platformRole as unknown;
  return {
    uid: auth.uid,
    email: typeof auth.token.email === 'string' ? auth.token.email.toLowerCase() : null,
    emailVerified: auth.token.email_verified === true,
    platformRole: PLATFORM_ROLES.includes(role as PlatformRole) ? (role as PlatformRole) : null,
  };
}

function callable<S extends z.ZodTypeAny, R>(
  schema: S,
  handler: (deps: Deps, actor: Actor, input: z.infer<S>) => Promise<R>,
  options: { memory?: '256MiB' | '512MiB' | '1GiB'; timeoutSeconds?: number; secrets?: string[] } = {},
) {
  return onCall({ ...BASE_OPTIONS, memory: '256MiB', enforceAppCheck: ENFORCE_APP_CHECK, ...options }, async (request) => {
    // Monitor mode: count calls that would be refused once App Check is enforced.
    if (!request.app && !ENFORCE_APP_CHECK && process.env.FUNCTIONS_EMULATOR !== 'true') {
      logger.info('appCheck.missing', { function: process.env.FUNCTION_TARGET });
    }
    const actor = actorFrom(request);
    const parsed = schema.safeParse(request.data);
    if (!parsed.success) {
      throw new HttpsError('invalid-argument', 'Some fields are invalid.', parsed.error.flatten());
    }
    try {
      return await handler(getDeps(), actor, parsed.data);
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error('Unhandled callable error', err);
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
  });
}

export const submitOrgSignup = callable(SubmitOrgSignupInput, signup.submitOrgSignup);
export const resubmitOrgSignup = callable(ResubmitOrgSignupInput, signup.resubmitOrgSignup);
export const reviewOrgSignup = callable(ReviewOrgSignupInput, reviewSvc, { secrets: MAIL_SECRETS });
export const setOrgStatus = callable(SetOrgStatusInput, setOrgStatusSvc);
export const updateOrgSettings = callable(UpdateOrgSettingsInput, settings.updateOrgSettings);
export const upsertSite = callable(UpsertSiteInput, settings.upsertSite);
export const deleteSite = callable(DeleteSiteInput, settings.deleteSite);
export const inviteMember = callable(InviteMemberInput, members.inviteMember, { secrets: MAIL_SECRETS });
export const acceptInvite = callable(AcceptInviteInput, members.acceptInvite);
export const revokeInvite = callable(RevokeInviteInput, members.revokeInvite);
export const updateMemberRole = callable(UpdateMemberRoleInput, members.updateMemberRole);
export const removeMember = callable(RemoveMemberInput, members.removeMember);
export const setMemberSites = callable(SetMemberSitesInput, members.setMemberSites);
export const saveRole = callable(SaveRoleInput, roles.saveRole);
export const deleteRole = callable(DeleteRoleInput, roles.deleteRole);

// Player app releases (in-app updates)
export const createPlayerReleaseUpload = callable(CreatePlayerReleaseInput, playerReleases.createPlayerReleaseUpload);
export const registerPlayerRelease = callable(RegisterPlayerReleaseInput, playerReleases.registerPlayerRelease, { memory: '512MiB', timeoutSeconds: 120 });
export const setPlayerRollout = callable(SetPlayerRolloutInput, playerReleases.setPlayerRollout);

// Platform settings
export const updatePlatformSettings = callable(UpdatePlatformSettingsInput, platformSettings.updatePlatformSettings);

// Support access (time-boxed, customer-visible)
export const grantSupportAccess = callable(GrantSupportAccessInput, support.grantSupportAccess);
export const requestSupportAccess = callable(RequestSupportAccessInput, support.requestSupportAccess);
export const emergencySupportAccess = callable(EmergencySupportAccessInput, support.emergencySupportAccess);
export const respondSupportRequest = callable(RespondSupportRequestInput, support.respondSupportRequest);
export const revokeSupportAccess = callable(SupportGrantRefInput, support.revokeSupportAccess);
export const openSupportAccess = callable(SupportGrantRefInput, support.openSupportAccess);

// Reseller accounts (groundwork)
export const saveAccount = callable(SaveAccountInput, accounts.saveAccount);
export const setOrgAccount = callable(SetOrgAccountInput, accounts.setOrgAccount);
export const setPlatformRole = callable(SetPlatformRoleInput, setPlatformRoleSvc);

// Content (phase 2)
export const createMediaUpload = callable(CreateMediaUploadInput, media.createMediaUpload);
export const updateMedia = callable(UpdateMediaInput, media.updateMedia);
export const deleteMedia = callable(DeleteMediaInput, media.deleteMedia);
export const upsertFolder = callable(UpsertFolderInput, media.upsertFolder);
export const deleteFolder = callable(DeleteFolderInput, media.deleteFolder);
export const saveLayout = callable(SaveLayoutInput, layouts.saveLayout);
export const deleteLayout = callable(DeleteLayoutInput, layouts.deleteLayout);
export const savePlaylist = callable(SavePlaylistInput, layouts.savePlaylist);
export const deletePlaylist = callable(DeletePlaylistInput, layouts.deletePlaylist);
export const upsertScreenGroup = callable(UpsertScreenGroupInput, schedules.upsertScreenGroup);
export const deleteScreenGroup = callable(DeleteScreenGroupInput, schedules.deleteScreenGroup);
export const saveSchedule = callable(SaveScheduleInput, schedules.saveSchedule);
export const deleteSchedule = callable(DeleteScheduleInput, schedules.deleteSchedule);

// Screens & publishing (phase 3)
export const claimDevice = callable(ClaimDeviceInput, screens.claimDevice);
export const authorizeScreen = callable(ScreenRefInput, screens.authorizeScreen);
export const updateScreen = callable(UpdateScreenInput, screens.updateScreen);
export const removeScreen = callable(ScreenRefInput, screens.removeScreen);
export const publishScreens = callable(PublishScreensInput.extend({ note: z.string().trim().max(500).optional() }), screens.publishScreens);

// Operations (phase 4)
export const reviewPublish = callable(ReviewPublishInput, screens.reviewPublish);
export const triggerEmergency = callable(TriggerEmergencyInput, emergency.triggerEmergency);
export const endEmergency = callable(EndEmergencyInput, emergency.endEmergency);
export const sendScreenCommand = callable(SendScreenCommandInput, commands.sendScreenCommand);
export const markNotificationsRead = callable(MarkNotificationsReadInput, commands.markNotificationsRead);

// Sensors (phase 5)
export const saveSensorDevice = callable(SaveSensorDeviceInput, sensors.saveSensorDevice);
export const rotateSensorKey = callable(SensorDeviceRefInput, sensors.rotateSensorKey);
export const deleteSensorDevice = callable(SensorDeviceRefInput, sensors.deleteSensorDevice);
export const saveSensorChannel = callable(SaveSensorChannelInput, sensors.saveSensorChannel);
export const deleteSensorChannel = callable(DeleteSensorChannelInput, sensors.deleteSensorChannel);
export const acknowledgeAlert = callable(AcknowledgeAlertInput, sensors.acknowledgeAlert);

// Billing (phase 6) — manual payments; invoices come from a separate app.
export const updateSubscription = callable(UpdateSubscriptionInput, billing.updateSubscription);
export const recordPayment = callable(RecordPaymentInput, billing.recordPayment);
export const voidPayment = callable(VoidPaymentInput, billing.voidPayment);
export const adjustBillingDates = callable(AdjustBillingDatesInput, billing.adjustBillingDates);
export const setCancellation = callable(SetCancellationInput, billing.setCancellation);
export const requestBillingChange = callable(RequestBillingChangeInput, billing.requestBillingChange);
export const resolveBillingRequest = callable(ResolveBillingRequestInput, billing.resolveBillingRequest);
export const savePlan = callable(SavePlanInput, plans.savePlan);
export const setFeatureRelease = callable(SetFeatureReleaseInput, plans.setFeatureRelease);
export const setEntitlementOverrides = callable(SetEntitlementOverridesInput, plans.setEntitlementOverrides);
export const migrateSubscriptions = callable(z.object({}), billing.migrateSubscriptions);

// Integrations (phase 6): weather, RSS and air quality data sources.
export const saveDataSource = callable(SaveDataSourceInput, integrations.saveDataSource);
export const deleteDataSource = callable(DataSourceRefInput, integrations.deleteDataSource);
export const geocodePlace = callable(GeocodeInput, integrations.geocodePlace, { secrets: WEATHER_SECRETS });
export const testRssFeed = callable(TestRssInput, integrations.testRssFeed);
export const previewDataSource = callable(DataSourceRefInput, integrations.previewDataSource, { secrets: WEATHER_SECRETS });
