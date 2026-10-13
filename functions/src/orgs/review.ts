import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  paths,
  TRIAL_DAYS,
  TRIAL_PLAN_ID,
  billingState,
  type OrgDoc,
  type OrgStatus,
  type ReviewOrgSignupInput,
  type SetOrgStatusInput,
  type SignupRequestDoc,
  type SubscriptionDoc,
} from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import { getOrg, requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { computeEntitlements } from '../lib/entitlements';
import { summaryOf, trialSubscription } from '../billing/billing';
import { fanOutOrgToProfiles, readMembers } from '../lib/profiles';


/** Super Admin decision on a pending organization: approve, reject or request information. */
export async function reviewOrgSignup(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof ReviewOrgSignupInput>,
): Promise<{ status: OrgStatus }> {
  requirePlatform(actor, 'org.approve');
  const at = now();
  const requestRef = db.doc(paths.signupRequest(input.requestId));
  const pre = await requestRef.get();
  if (!pre.exists) throw new HttpsError('not-found', 'Request not found.');
  const orgId = (pre.data() as SignupRequestDoc).orgId;

  return auditedTransaction(db, [orgId], async (tx, audit) => {
    const request = (await tx.get(requestRef)).data() as SignupRequestDoc;
    const org = await getOrg(tx, db, orgId);
    const members = await readMembers(tx, db, orgId);

    const allowedFrom: Record<typeof input.decision, SignupRequestDoc['status'][]> = {
      approve: ['pending', 'info_requested'],
      reject: ['pending', 'info_requested'],
      request_info: ['pending'],
    };
    if (!allowedFrom[input.decision].includes(request.status)) {
      throw new HttpsError('failed-precondition', `Request is already ${request.status}.`);
    }

    // Reads for approval must happen before any write.
    const entitlements =
      input.decision === 'approve' ? await computeEntitlements(tx, db, orgId, TRIAL_PLAN_ID, at) : null;

    const next: Record<typeof input.decision, { org: OrgStatus; request: SignupRequestDoc['status'] }> = {
      approve: { org: 'active', request: 'approved' },
      reject: { org: 'rejected', request: 'rejected' },
      request_info: { org: 'info_requested', request: 'info_requested' },
    };
    const status = next[input.decision];

    // Trial on the trial plan; the screen limit comes from the plan.
    let subscription: SubscriptionDoc | null = null;
    if (entitlements) {
      const sub = trialSubscription(TRIAL_PLAN_ID, TRIAL_DAYS, entitlements.limits.screens ?? 1, at, actor.uid);
      const state = billingState(sub, at);
      subscription = { ...sub, status: state.status, nextTransitionAt: state.nextTransitionAt };
    }

    const messages = input.message
      ? [...request.messages, { at, from: 'admin' as const, authorId: actor.uid, text: input.message }]
      : request.messages;
    tx.update(requestRef, {
      status: status.request,
      messages,
      updatedAt: at,
      ...(input.decision === 'request_info' ? {} : { decidedBy: actor.uid, decidedAt: at }),
    });
    tx.update(db.doc(paths.org(orgId)), {
      status: status.org,
      updatedAt: at,
      statusReason: input.message ?? null,
      ...(subscription ? { billing: summaryOf(subscription) } : {}),
    });

    if (entitlements && subscription) {
      tx.set(db.doc(paths.orgSubscription(orgId)), subscription);
      tx.set(db.doc(paths.orgEntitlements(orgId)), entitlements);
      tx.set(db.doc(paths.orgUsage(orgId)), { screens: 0, users: members.length, storageBytes: 0, updatedAt: at });
    }

    fanOutOrgToProfiles(tx, db, members, { id: orgId, name: org.name, status: status.org }, at);
    audit(orgId, {
      at,
      actorType: 'platform_user',
      actorId: actor.uid,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      orgId,
      action: `org.signup.${input.decision}`,
      target: { type: 'org', id: orgId },
      ...(input.message ? { reason: input.message } : {}),
    });
    return { status: status.org };
  });
}

/** Super Admin suspends an active org or reactivates a suspended one. */
export async function setOrgStatus(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SetOrgStatusInput>,
): Promise<{ status: OrgStatus }> {
  requirePlatform(actor, 'org.suspend');
  const at = now();

  return auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const org: OrgDoc = await getOrg(tx, db, input.orgId);
    const members = await readMembers(tx, db, input.orgId);
    const [from, to]: [OrgStatus, OrgStatus] =
      input.action === 'suspend' ? ['active', 'suspended'] : ['suspended', 'active'];
    if (org.status !== from) {
      throw new HttpsError('failed-precondition', `Organization is ${org.status}, expected ${from}.`);
    }

    tx.update(db.doc(paths.org(input.orgId)), { status: to, statusReason: input.reason, updatedAt: at });
    fanOutOrgToProfiles(tx, db, members, { id: org.id, name: org.name, status: to }, at);
    audit(input.orgId, {
      at,
      actorType: 'platform_user',
      actorId: actor.uid,
      ...(actor.email ? { actorEmail: actor.email } : {}),
      orgId: input.orgId,
      action: `org.${input.action}`,
      target: { type: 'org', id: input.orgId },
      reason: input.reason,
    });
    return { status: to };
  });
}
