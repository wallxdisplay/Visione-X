import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import type { z } from 'zod';
import {
  AcceptInviteInput,
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
} from '@visione-x/shared';
import { setPlatformRole as setPlatformRoleSvc } from './admin/platformUsers';
import { getDeps } from './lib/admin';
import type { Actor, Deps } from './lib/context';
import * as members from './members/members';
import { reviewOrgSignup as reviewSvc, setOrgStatus as setOrgStatusSvc } from './orgs/review';
import * as settings from './orgs/settings';
import * as signup from './orgs/signup';
import { BASE_OPTIONS } from './options';

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
) {
  return onCall({ ...BASE_OPTIONS, memory: '256MiB' }, async (request) => {
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
export const reviewOrgSignup = callable(ReviewOrgSignupInput, reviewSvc);
export const setOrgStatus = callable(SetOrgStatusInput, setOrgStatusSvc);
export const updateOrgSettings = callable(UpdateOrgSettingsInput, settings.updateOrgSettings);
export const upsertSite = callable(UpsertSiteInput, settings.upsertSite);
export const deleteSite = callable(DeleteSiteInput, settings.deleteSite);
export const inviteMember = callable(InviteMemberInput, members.inviteMember);
export const acceptInvite = callable(AcceptInviteInput, members.acceptInvite);
export const revokeInvite = callable(RevokeInviteInput, members.revokeInvite);
export const updateMemberRole = callable(UpdateMemberRoleInput, members.updateMemberRole);
export const removeMember = callable(RemoveMemberInput, members.removeMember);
export const setPlatformRole = callable(SetPlatformRoleInput, setPlatformRoleSvc);
