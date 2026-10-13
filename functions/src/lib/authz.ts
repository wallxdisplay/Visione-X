import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  BILLING_LOCKED_PERMISSIONS,
  hasPlatformPermission,
  paths,
  type MemberDoc,
  type OrgDoc,
  type OrgPermission,
  type PlatformPermission,
} from '@wallx-play/shared';
import type { Actor } from './context';

export function requireVerifiedEmail(actor: Actor): asserts actor is Actor & { email: string } {
  if (!actor.email || !actor.emailVerified) {
    throw new HttpsError('failed-precondition', 'Verify your email address first.');
  }
}

export function requirePlatform(actor: Actor, permission: PlatformPermission): void {
  if (!hasPlatformPermission(actor.platformRole, permission)) {
    throw new HttpsError('permission-denied', 'You do not have permission for this action.');
  }
}

export async function getOrg(tx: Transaction, db: Firestore, orgId: string): Promise<OrgDoc> {
  const snap = await tx.get(db.doc(paths.org(orgId)));
  if (!snap.exists) throw new HttpsError('not-found', 'Organization not found.');
  return snap.data() as OrgDoc;
}

export function requireOrgActive(org: OrgDoc): void {
  if (org.status !== 'active') {
    throw new HttpsError(
      'failed-precondition',
      'This organization is not active. Pending, suspended or rejected organizations cannot make changes.',
    );
  }
}

export async function getMember(
  tx: Transaction,
  db: Firestore,
  orgId: string,
  uid: string,
): Promise<MemberDoc | null> {
  const snap = await tx.get(db.doc(paths.member(orgId, uid)));
  return snap.exists ? (snap.data() as MemberDoc) : null;
}

/**
 * Permission + active org in one call (reads only; safe before transaction writes).
 * While billing is restricted, editing and publishing permissions are refused.
 */
export async function requireActiveOrgPermission(
  tx: Transaction,
  db: Firestore,
  actor: Actor,
  orgId: string,
  permission: OrgPermission,
): Promise<{ member: MemberDoc; org: OrgDoc }> {
  const member = await requireOrgPermission(tx, db, actor, orgId, permission);
  const org = await getOrg(tx, db, orgId);
  requireOrgActive(org);
  if (org.billing?.restricted && BILLING_LOCKED_PERMISSIONS.includes(permission)) {
    throw new HttpsError(
      'failed-precondition',
      'Your subscription has lapsed, so editing and publishing are paused. Screens keep playing their current content. Contact WallX billing to renew.',
    );
  }
  return { member, org };
}

/** Loads the caller's membership and checks one permission. Returns the member. */
export async function requireOrgPermission(
  tx: Transaction,
  db: Firestore,
  actor: Actor,
  orgId: string,
  permission: OrgPermission,
): Promise<MemberDoc> {
  const member = await getMember(tx, db, orgId, actor.uid);
  if (!member || member.status !== 'active' || !member.permissions.includes(permission)) {
    throw new HttpsError('permission-denied', 'You do not have permission for this action.');
  }
  return member;
}
