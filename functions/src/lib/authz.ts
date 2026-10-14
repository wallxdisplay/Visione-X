import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  BILLING_LOCKED_PERMISSIONS,
  ORG_WIDE_PERMISSIONS,
  hasPlatformPermission,
  inSiteScope,
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

/**
 * Platform staff must sign in with a second factor (TOTP, docs/DEVELOPMENT.md). Required on
 * deployed functions; off in the emulators, which cannot do TOTP. Tests switch it to cover both.
 */
export const staffMfa = { required: process.env.FUNCTIONS_EMULATOR !== 'true' };

/** Refuses a platform staff session that was not signed in with a second factor. */
export function requireStaffSecondFactor(actor: Actor): void {
  if (staffMfa.required && actor.platformRole && !actor.secondFactor) {
    throw new HttpsError(
      'permission-denied',
      'WallX staff must use two-step verification. Set it up under Account security, then sign in again.',
    );
  }
}

export function requirePlatform(actor: Actor, permission: PlatformPermission): void {
  if (!hasPlatformPermission(actor.platformRole, permission)) {
    throw new HttpsError('permission-denied', 'You do not have permission for this action.');
  }
  requireStaffSecondFactor(actor);
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
  if (!member || member.status !== 'active' || !member.permissions.includes(permission) || supportExpired(member)) {
    throw new HttpsError('permission-denied', 'You do not have permission for this action.');
  }
  if (member.siteScope?.length && ORG_WIDE_PERMISSIONS.includes(permission)) {
    throw new HttpsError('permission-denied', 'Your access is limited to some sites, so organization-wide settings are not available to you.');
  }
  return member;
}

/** Time source for membership expiry (tests point it at their fake clock). */
export const authzClock = { now: () => Date.now() };

/** A support member whose grant ended (the monitor removes the record within minutes). */
export const supportExpired = (member: Pick<MemberDoc, 'support'>) => !!member.support && member.support.expiresAt <= authzClock.now();

/** Site-scoped members may act only on their sites (screens, sensors, sites, schedules). */
export function requireSiteInScope(member: Pick<MemberDoc, 'siteScope'>, siteId: string | null | undefined, what = 'this'): void {
  if (!inSiteScope(member.siteScope, siteId)) {
    throw new HttpsError('permission-denied', `Your access is limited to some sites; ${what} is outside them.`);
  }
}
