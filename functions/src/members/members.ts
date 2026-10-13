import { createHash, randomBytes } from 'node:crypto';
import type { Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  INVITE_TTL_DAYS,
  paths,
  SYSTEM_ORG_ROLE_PERMISSIONS,
  withinLimit,
  type AcceptInviteInput,
  type InviteDoc,
  type InviteMemberInput,
  type MemberDoc,
  type RemoveMemberInput,
  type RevokeInviteInput,
  type SetMemberSitesInput,
  type UpdateMemberRoleInput,
} from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import {
  getMember,
  getOrg,
  requireOrgActive,
  requireOrgPermission,
  requireVerifiedEmail,
} from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements } from '../lib/entitlements';
import { setMembership } from '../lib/profiles';

const DAY_MS = 86_400_000;

/** Owners are never limited to sites; every listed site must exist (reads only). */
async function checkSiteScope(tx: Transaction, db: Deps['db'], orgId: string, role: MemberDoc['role'], siteScope: string[]) {
  if (siteScope.length === 0) return;
  if (role === 'owner') throw new HttpsError('invalid-argument', 'Owners always have access to all sites.');
  const snaps = await Promise.all(siteScope.map((id) => tx.get(db.doc(paths.site(orgId, id)))));
  if (snaps.some((s) => !s.exists)) throw new HttpsError('invalid-argument', 'A selected site no longer exists.');
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function userAudit(actor: Actor) {
  return {
    actorType: 'user' as const,
    actorId: actor.uid,
    ...(actor.email ? { actorEmail: actor.email } : {}),
  };
}

/**
 * Creates an invitation. Returns the raw token once (to build the invite link); only its
 * hash is stored. Email delivery is added with the notification engine.
 */
export async function inviteMember(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof InviteMemberInput>,
): Promise<{ inviteId: string; token: string; expiresAt: number }> {
  const at = now();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const inviteRef = db.collection(paths.invites(input.orgId)).doc();
  const expiresAt = at + INVITE_TTL_DAYS * DAY_MS;
  // Direct service callers may omit it (the callable schema defaults it to all sites).
  const siteScope = input.siteScope ?? [];

  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const me = await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    requireOrgActive(await getOrg(tx, db, input.orgId));
    if (input.role === 'owner' && me.role !== 'owner') {
      throw new HttpsError('permission-denied', 'Only owners can invite another owner.');
    }
    await checkSiteScope(tx, db, input.orgId, input.role, siteScope);

    const entitlements = await readEntitlements(tx, db, input.orgId);
    const [members, pendingInvites, existingMember, existingInvite] = await Promise.all([
      tx.get(db.collection(paths.members(input.orgId)).where('status', '==', 'active')),
      tx.get(db.collection(paths.invites(input.orgId)).where('status', '==', 'pending')),
      tx.get(db.collection(paths.members(input.orgId)).where('email', '==', input.email).limit(1)),
      tx.get(
        db
          .collection(paths.invites(input.orgId))
          .where('email', '==', input.email)
          .where('status', '==', 'pending')
          .limit(1),
      ),
    ]);
    if (!existingMember.empty) throw new HttpsError('already-exists', 'This person is already a member.');
    if (existingInvite.docs.some((d) => (d.data() as InviteDoc).expiresAt > at)) {
      throw new HttpsError('already-exists', 'An invitation is already pending for this email.');
    }
    const liveInvites = pendingInvites.docs.filter((d) => (d.data() as InviteDoc).expiresAt > at).length;
    if (!withinLimit(entitlements.limits, 'users', members.size + liveInvites + 1)) {
      throw new HttpsError('resource-exhausted', 'Your plan’s user limit has been reached.');
    }

    const invite: InviteDoc = {
      id: inviteRef.id,
      email: input.email,
      role: input.role,
      tokenHash,
      status: 'pending',
      invitedBy: actor.uid,
      createdAt: at,
      expiresAt,
      siteScope,
    };
    tx.create(inviteRef, invite);
    tx.create(db.doc(paths.inviteToken(tokenHash)), { orgId: input.orgId, inviteId: inviteRef.id });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'member.invited',
      target: { type: 'invite', id: inviteRef.id },
      data: { email: input.email, role: input.role, siteScope },
    });
  });

  return { inviteId: inviteRef.id, token, expiresAt };
}

export async function acceptInvite(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof AcceptInviteInput>,
): Promise<{ orgId: string }> {
  requireVerifiedEmail(actor);
  const email = actor.email.toLowerCase();
  const at = now();
  const tokenRef = db.doc(paths.inviteToken(hashToken(input.token)));
  const lookup = await tokenRef.get();
  if (!lookup.exists) throw new HttpsError('not-found', 'This invitation is invalid or was already used.');
  const { orgId, inviteId } = lookup.data() as { orgId: string; inviteId: string };

  await auditedTransaction(db, [orgId], async (tx, audit) => {
    const tokenSnap = await tx.get(tokenRef);
    if (!tokenSnap.exists) throw new HttpsError('not-found', 'This invitation was already used.');
    const inviteRef = db.doc(paths.invite(orgId, inviteId));
    const invite = (await tx.get(inviteRef)).data() as InviteDoc | undefined;
    if (!invite || invite.status !== 'pending') {
      throw new HttpsError('not-found', 'This invitation is no longer valid.');
    }
    if (invite.expiresAt <= at) throw new HttpsError('deadline-exceeded', 'This invitation has expired.');
    if (invite.email !== email) {
      throw new HttpsError('permission-denied', 'This invitation was sent to a different email address.');
    }
    const org = await getOrg(tx, db, orgId);
    requireOrgActive(org);
    const existing = await getMember(tx, db, orgId, actor.uid);
    if (existing) throw new HttpsError('already-exists', 'You are already a member of this organization.');

    const member: MemberDoc = {
      uid: actor.uid,
      email,
      role: invite.role,
      permissions: [...SYSTEM_ORG_ROLE_PERMISSIONS[invite.role]],
      siteScope: invite.siteScope ?? [],
      status: 'active',
      joinedAt: at,
      invitedBy: invite.invitedBy,
    };
    tx.create(db.doc(paths.member(orgId, actor.uid)), member);
    tx.update(inviteRef, { status: 'accepted' });
    tx.delete(tokenRef);
    setMembership(tx, db, {
      uid: actor.uid,
      email,
      orgId,
      membership: { orgName: org.name, orgStatus: org.status, role: invite.role },
      now: at,
    });
    audit(orgId, {
      at,
      ...userAudit(actor),
      orgId,
      action: 'member.joined',
      target: { type: 'member', id: actor.uid },
      data: { role: invite.role, inviteId },
    });
  });
  return { orgId };
}

export async function revokeInvite(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof RevokeInviteInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    const inviteRef = db.doc(paths.invite(input.orgId, input.inviteId));
    const invite = (await tx.get(inviteRef)).data() as InviteDoc | undefined;
    if (!invite || invite.status !== 'pending') throw new HttpsError('not-found', 'Invitation not found.');

    tx.update(inviteRef, { status: 'revoked' });
    tx.delete(db.doc(paths.inviteToken(invite.tokenHash)));
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'member.invite.revoked',
      target: { type: 'invite', id: input.inviteId },
      data: { email: invite.email },
    });
  });
}

async function countOwners(tx: Transaction, db: Deps['db'], orgId: string) {
  const snap = await tx.get(
    db.collection(paths.members(orgId)).where('role', '==', 'owner').where('status', '==', 'active'),
  );
  return snap.size;
}

export async function updateMemberRole(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof UpdateMemberRoleInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const me = await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    const org = await getOrg(tx, db, input.orgId);
    requireOrgActive(org);
    const target = await getMember(tx, db, input.orgId, input.uid);
    if (!target) throw new HttpsError('not-found', 'Member not found.');
    if (target.role === input.role) return;
    if ((target.role === 'owner' || input.role === 'owner') && me.role !== 'owner') {
      throw new HttpsError('permission-denied', 'Only owners can grant or change the owner role.');
    }
    if (target.role === 'owner' && (await countOwners(tx, db, input.orgId)) <= 1) {
      throw new HttpsError('failed-precondition', 'An organization must keep at least one owner.');
    }

    tx.update(db.doc(paths.member(input.orgId, input.uid)), {
      role: input.role,
      permissions: [...SYSTEM_ORG_ROLE_PERMISSIONS[input.role]],
      // Owners always have every site.
      ...(input.role === 'owner' ? { siteScope: [] } : {}),
    });
    setMembership(tx, db, {
      uid: target.uid,
      email: target.email,
      orgId: input.orgId,
      membership: { orgName: org.name, orgStatus: org.status, role: input.role },
      now: at,
    });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'member.role.changed',
      target: { type: 'member', id: input.uid },
      data: { email: target.email, before: target.role, after: input.role },
    });
  });
}

/** Removes a member. Anyone may leave; removing others needs member.manage. */
export async function removeMember(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof RemoveMemberInput>,
): Promise<void> {
  const at = now();
  const self = input.uid === actor.uid;
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const me = self
      ? await getMember(tx, db, input.orgId, actor.uid)
      : await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    const target = self ? me : await getMember(tx, db, input.orgId, input.uid);
    if (!me || !target) throw new HttpsError('not-found', 'Member not found.');
    if (target.role === 'owner') {
      if (!self && me.role !== 'owner') {
        throw new HttpsError('permission-denied', 'Only owners can remove an owner.');
      }
      if ((await countOwners(tx, db, input.orgId)) <= 1) {
        throw new HttpsError('failed-precondition', 'An organization must keep at least one owner.');
      }
    }

    tx.delete(db.doc(paths.member(input.orgId, input.uid)));
    setMembership(tx, db, { uid: target.uid, email: target.email, orgId: input.orgId, membership: null, now: at });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: self ? 'member.left' : 'member.removed',
      target: { type: 'member', id: input.uid },
      data: { email: target.email, role: target.role },
    });
  });
}

/** Limits a member to some sites (or gives back all sites with an empty list). */
export async function setMemberSites(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SetMemberSitesInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    requireOrgActive(await getOrg(tx, db, input.orgId));
    const target = await getMember(tx, db, input.orgId, input.uid);
    if (!target) throw new HttpsError('not-found', 'Member not found.');
    await checkSiteScope(tx, db, input.orgId, target.role, input.siteScope);
    tx.update(db.doc(paths.member(input.orgId, input.uid)), { siteScope: input.siteScope });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'member.sites.changed',
      target: { type: 'member', id: input.uid },
      data: { email: target.email, before: target.siteScope ?? [], after: input.siteScope },
    });
  });
}
