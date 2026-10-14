/**
 * Support access: time-boxed, customer-visible grants for WallX support staff
 * (packages/shared/src/support.ts). Every step is audited in the organization's chain.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  hasPlatformPermission,
  paths,
  SUPPORT_LEVEL_PERMISSIONS,
  SUPPORT_LEVEL_ROLE,
  supportGrantActive,
  type EmergencySupportAccessInput,
  type GrantSupportAccessInput,
  type MemberDoc,
  type RequestSupportAccessInput,
  type RespondSupportRequestInput,
  type SupportGrantDoc,
  type SupportGrantRefInput,
  type SupportPerson,
} from '@wallx-play/shared';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { getMember, getOrg, requireOrgPermission, requirePlatform } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { notify } from '../lib/notify';
import { setMembership } from '../lib/profiles';

const HOUR = 3_600_000;
/** Unanswered staff requests lapse after this long. */
const REQUEST_TTL_MS = 7 * 24 * HOUR;

const person = (actor: Actor): SupportPerson => ({ uid: actor.uid, email: actor.email });
const userAudit = (actor: Actor) => ({ actorType: 'user' as const, actorId: actor.uid, ...(actor.email ? { actorEmail: actor.email } : {}) });

async function readGrant(tx: Transaction, db: Firestore, orgId: string, grantId: string): Promise<SupportGrantDoc> {
  const grant = (await tx.get(db.doc(paths.supportGrant(orgId, grantId)))).data() as SupportGrantDoc | undefined;
  if (!grant) throw new HttpsError('not-found', 'Support access not found.');
  return grant;
}

/** Ends a grant and removes the temporary member records it created (reads must be done by the caller). */
function endGrant(tx: Transaction, db: Firestore, grant: SupportGrantDoc, status: 'revoked' | 'expired', at: number, staff: MemberDoc[]) {
  tx.update(db.doc(paths.supportGrant(grant.orgId, grant.id)), { status, endedAt: at });
  for (const m of staff) {
    if (m.support?.grantId !== grant.id) continue;
    tx.delete(db.doc(paths.member(grant.orgId, m.uid)));
    setMembership(tx, db, { uid: m.uid, email: m.email, orgId: grant.orgId, membership: null, now: at });
  }
}

async function openedMembers(tx: Transaction, db: Firestore, grant: SupportGrantDoc): Promise<MemberDoc[]> {
  const docs = await Promise.all(grant.openedBy.map((uid) => getMember(tx, db, grant.orgId, uid)));
  return docs.filter((m): m is MemberDoc => !!m);
}

function newGrant(orgId: string, id: string, at: number, fields: Pick<SupportGrantDoc, 'status' | 'level' | 'hours' | 'reason' | 'origin' | 'requestedBy' | 'decidedBy'>): SupportGrantDoc {
  const active = fields.status === 'active';
  return {
    id,
    orgId,
    ...fields,
    createdAt: at,
    decidedAt: active ? at : null,
    expiresAt: active ? at + fields.hours * HOUR : null,
    endedAt: null,
    openedBy: [],
  };
}

/** The customer gives WallX support access (Help & Support). */
export async function grantSupportAccess({ db, now }: Deps, actor: Actor, input: z.infer<typeof GrantSupportAccessInput>): Promise<{ grantId: string }> {
  const ref = db.collection(paths.supportGrants(input.orgId)).doc();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    await getOrg(tx, db, input.orgId);
    const at = now();
    const grant = newGrant(input.orgId, ref.id, at, { status: 'active', level: input.level, hours: input.hours, reason: input.reason ?? '', origin: 'customer', requestedBy: null, decidedBy: person(actor) });
    tx.create(ref, grant);
    audit(input.orgId, { at, ...userAudit(actor), orgId: input.orgId, action: 'support.access.granted', target: { type: 'supportGrant', id: ref.id }, data: { level: grant.level, hours: grant.hours, origin: 'customer' } });
  });
  return { grantId: ref.id };
}

/** Support staff ask for access; owners and admins approve or decline it. */
export async function requestSupportAccess({ db, now }: Deps, actor: Actor, input: z.infer<typeof RequestSupportAccessInput>): Promise<{ grantId: string }> {
  requirePlatform(actor, 'support.access.request');
  const ref = db.collection(paths.supportGrants(input.orgId)).doc();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const org = await getOrg(tx, db, input.orgId);
    const at = now();
    const grant = newGrant(input.orgId, ref.id, at, { status: 'requested', level: input.level, hours: input.hours, reason: input.reason, origin: 'staff_request', requestedBy: person(actor), decidedBy: null });
    tx.create(ref, grant);
    notify(tx, db, input.orgId, 'support_access_requested', { hours: input.hours, reason: input.reason }, '/help', at);
    audit(input.orgId, { at, ...platformAudit(actor), orgId: input.orgId, action: 'support.access.requested', target: { type: 'supportGrant', id: ref.id }, reason: input.reason, data: { level: grant.level, hours: grant.hours, org: org.name } });
  });
  return { grantId: ref.id };
}

/** Superadmin emergency access without waiting for the customer (audited; the customer is notified). */
export async function emergencySupportAccess({ db, now }: Deps, actor: Actor, input: z.infer<typeof EmergencySupportAccessInput>): Promise<{ grantId: string }> {
  requirePlatform(actor, 'support.access.grant');
  const ref = db.collection(paths.supportGrants(input.orgId)).doc();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await getOrg(tx, db, input.orgId);
    const at = now();
    const grant = newGrant(input.orgId, ref.id, at, { status: 'active', level: input.level, hours: input.hours, reason: input.reason, origin: 'emergency', requestedBy: person(actor), decidedBy: person(actor) });
    tx.create(ref, grant);
    notify(tx, db, input.orgId, 'support_access_granted', { hours: input.hours, reason: input.reason }, '/help', at);
    audit(input.orgId, { at, ...platformAudit(actor), orgId: input.orgId, action: 'support.access.emergency', target: { type: 'supportGrant', id: ref.id }, reason: input.reason, data: { level: grant.level, hours: grant.hours } });
  });
  return { grantId: ref.id };
}

/** Owner or admin answers a staff request. */
export async function respondSupportRequest({ db, now }: Deps, actor: Actor, input: z.infer<typeof RespondSupportRequestInput>): Promise<void> {
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    const grant = await readGrant(tx, db, input.orgId, input.grantId);
    if (grant.status !== 'requested') throw new HttpsError('failed-precondition', 'This request was already answered.');
    const at = now();
    tx.update(db.doc(paths.supportGrant(input.orgId, input.grantId)), input.approve
      ? { status: 'active', decidedBy: person(actor), decidedAt: at, expiresAt: at + grant.hours * HOUR }
      : { status: 'declined', decidedBy: person(actor), decidedAt: at, endedAt: at });
    audit(input.orgId, { at, ...userAudit(actor), orgId: input.orgId, action: input.approve ? 'support.access.approved' : 'support.access.declined', target: { type: 'supportGrant', id: input.grantId }, data: { level: grant.level, hours: grant.hours } });
  });
}

/** The customer (member.manage) or a superadmin ends access now. */
export async function revokeSupportAccess({ db, now }: Deps, actor: Actor, input: z.infer<typeof SupportGrantRefInput>): Promise<void> {
  const staff = hasPlatformPermission(actor.platformRole, 'support.access.grant');
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    if (!staff) await requireOrgPermission(tx, db, actor, input.orgId, 'member.manage');
    await getOrg(tx, db, input.orgId);
    const grant = await readGrant(tx, db, input.orgId, input.grantId);
    if (grant.status !== 'active' && grant.status !== 'requested') throw new HttpsError('failed-precondition', 'This support access has already ended.');
    const members = await openedMembers(tx, db, grant);
    const at = now();
    endGrant(tx, db, grant, 'revoked', at, members);
    audit(input.orgId, { at, ...(staff ? platformAudit(actor) : userAudit(actor)), orgId: input.orgId, action: 'support.access.revoked', target: { type: 'supportGrant', id: input.grantId }, data: { staffRemoved: members.length } });
  });
}

/** A support staff member enters the organization with an active grant (temporary member record). */
export async function openSupportAccess({ db, now }: Deps, actor: Actor, input: z.infer<typeof SupportGrantRefInput>): Promise<void> {
  requirePlatform(actor, 'support.access.request');
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const org = await getOrg(tx, db, input.orgId);
    const grant = await readGrant(tx, db, input.orgId, input.grantId);
    const at = now();
    if (!supportGrantActive(grant, at)) throw new HttpsError('failed-precondition', 'This support access is not active.');
    const existing = await getMember(tx, db, input.orgId, actor.uid);
    if (existing && !existing.support) throw new HttpsError('failed-precondition', 'You are already a regular member of this organization.');
    const member: MemberDoc = {
      uid: actor.uid,
      email: actor.email ?? '',
      role: SUPPORT_LEVEL_ROLE[grant.level],
      permissions: [...SUPPORT_LEVEL_PERMISSIONS[grant.level]],
      siteScope: [],
      status: 'active',
      joinedAt: at,
      invitedBy: null,
      support: { grantId: grant.id, expiresAt: grant.expiresAt! },
    };
    tx.set(db.doc(paths.member(input.orgId, actor.uid)), member);
    if (!grant.openedBy.includes(actor.uid)) {
      tx.update(db.doc(paths.supportGrant(input.orgId, input.grantId)), { openedBy: [...grant.openedBy, actor.uid] });
    }
    setMembership(tx, db, { uid: actor.uid, email: actor.email ?? '', orgId: input.orgId, membership: { orgName: org.name, orgStatus: org.status, role: member.role }, now: at });
    audit(input.orgId, { at, ...platformAudit(actor), orgId: input.orgId, action: 'support.access.opened', target: { type: 'supportGrant', id: input.grantId }, data: { level: grant.level } });
  });
}

/** Monitor: end grants whose time is up and lapse unanswered requests. */
export async function expireSupportGrants({ db, now }: Deps): Promise<number> {
  const at = now();
  const [due, stale] = await Promise.all([
    db.collectionGroup('supportGrants').where('status', '==', 'active').where('expiresAt', '<=', at).limit(100).get(),
    db.collectionGroup('supportGrants').where('status', '==', 'requested').where('createdAt', '<=', at - REQUEST_TTL_MS).limit(100).get(),
  ]);
  for (const d of [...due.docs, ...stale.docs]) {
    const { orgId, id } = d.data() as SupportGrantDoc;
    await auditedTransaction(db, [orgId], async (tx, audit) => {
      await getOrg(tx, db, orgId);
      const grant = await readGrant(tx, db, orgId, id);
      if (grant.status !== 'active' && grant.status !== 'requested') return;
      const members = await openedMembers(tx, db, grant);
      endGrant(tx, db, grant, 'expired', at, members);
      audit(orgId, { at, actorType: 'system', actorId: 'support-expiry', orgId, action: 'support.access.expired', target: { type: 'supportGrant', id }, data: { staffRemoved: members.length } });
    });
  }
  return due.size + stale.size;
}
