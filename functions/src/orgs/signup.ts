import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  paths,
  SYSTEM_ORG_ROLE_PERMISSIONS,
  type MemberDoc,
  type OrgDoc,
  type ResubmitOrgSignupInput,
  type SignupRequestDoc,
  type SubmitOrgSignupInput,
} from '@visione-x/shared';
import { auditedTransaction } from '../lib/audit';
import { requireVerifiedEmail } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { fanOutOrgToProfiles, readMembers, setMembership } from '../lib/profiles';

const OPEN_STATUSES: SignupRequestDoc['status'][] = ['pending', 'info_requested'];

/**
 * A verified user requests a new organization. The org is created in `pending` state with
 * the requester as owner; nothing can be published or paired until a Super Admin approves.
 */
export async function submitOrgSignup(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SubmitOrgSignupInput>,
): Promise<{ orgId: string; requestId: string }> {
  requireVerifiedEmail(actor);
  const orgId = db.collection('orgs').doc().id;
  const requestId = db.collection(paths.signupRequests()).doc().id;
  const at = now();

  await auditedTransaction(db, [orgId], async (tx, audit) => {
    const open = await tx.get(
      db
        .collection(paths.signupRequests())
        .where('requestedBy', '==', actor.uid)
        .where('status', 'in', OPEN_STATUSES)
        .limit(1),
    );
    if (!open.empty) {
      throw new HttpsError('already-exists', 'You already have an organization request under review.');
    }

    const org: OrgDoc = {
      id: orgId,
      name: input.orgName,
      status: 'pending',
      parentAccountId: null,
      timezone: input.timezone,
      locale: 'en-IN',
      signupRequestId: requestId,
      createdBy: actor.uid,
      createdAt: at,
      updatedAt: at,
    };
    const owner: MemberDoc = {
      uid: actor.uid,
      email: actor.email,
      role: 'owner',
      permissions: [...SYSTEM_ORG_ROLE_PERMISSIONS.owner],
      siteScope: [],
      status: 'active',
      joinedAt: at,
      invitedBy: null,
    };
    const request: SignupRequestDoc = {
      id: requestId,
      orgId,
      requestedBy: actor.uid,
      requesterEmail: actor.email,
      status: 'pending',
      details: input,
      messages: [],
      createdAt: at,
      updatedAt: at,
    };

    tx.create(db.doc(paths.org(orgId)), stripUndefined(org));
    tx.create(db.doc(paths.member(orgId, actor.uid)), owner);
    tx.create(db.doc(paths.signupRequest(requestId)), stripUndefined(request));
    setMembership(tx, db, {
      uid: actor.uid,
      email: actor.email,
      orgId,
      membership: { orgName: org.name, orgStatus: 'pending', role: 'owner' },
      now: at,
    });
    audit(orgId, {
      at,
      actorType: 'user',
      actorId: actor.uid,
      actorEmail: actor.email,
      orgId,
      action: 'org.signup.submitted',
      target: { type: 'org', id: orgId },
      data: { orgName: input.orgName, expectedScreens: input.expectedScreens },
    });
  });

  return { orgId, requestId };
}

/** Requester answers an "information requested" decision and sends the request back for review. */
export async function resubmitOrgSignup(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof ResubmitOrgSignupInput>,
): Promise<void> {
  requireVerifiedEmail(actor);
  const at = now();
  const requestRef = db.doc(paths.signupRequest(input.requestId));

  // The org id is needed to open the audit chain, so read it before the transaction and
  // re-check inside it.
  const pre = await requestRef.get();
  if (!pre.exists) throw new HttpsError('not-found', 'Request not found.');
  const orgId = (pre.data() as SignupRequestDoc).orgId;

  await auditedTransaction(db, [orgId], async (tx, audit) => {
    const snap = await tx.get(requestRef);
    const request = snap.data() as SignupRequestDoc;
    if (request.requestedBy !== actor.uid) {
      throw new HttpsError('permission-denied', 'This request belongs to another user.');
    }
    if (request.status !== 'info_requested') {
      throw new HttpsError('failed-precondition', 'This request is not waiting for more information.');
    }
    const members = await readMembers(tx, db, orgId);

    tx.update(requestRef, {
      details: stripUndefined(input.details),
      status: 'pending',
      messages: [
        ...request.messages,
        { at, from: 'requester', authorId: actor.uid, text: input.response },
      ],
      updatedAt: at,
    });
    tx.update(db.doc(paths.org(orgId)), {
      name: input.details.orgName,
      timezone: input.details.timezone,
      status: 'pending',
      updatedAt: at,
    });
    fanOutOrgToProfiles(tx, db, members, { id: orgId, name: input.details.orgName, status: 'pending' }, at);
    audit(orgId, {
      at,
      actorType: 'user',
      actorId: actor.uid,
      actorEmail: actor.email,
      orgId,
      action: 'org.signup.resubmitted',
      target: { type: 'signupRequest', id: input.requestId },
    });
  });
}

export function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
