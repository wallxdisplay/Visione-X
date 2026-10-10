import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { paths, type MemberDoc, type OrgStatus, type UserMembership } from '@visione-x/shared';

/** Adds/updates (or removes, when membership is null) one org in users/{uid}.memberships. */
export function setMembership(
  tx: Transaction,
  db: Firestore,
  args: { uid: string; email: string; orgId: string; membership: UserMembership | null; now: number },
): void {
  const { uid, email, orgId, membership, now } = args;
  tx.set(
    db.doc(paths.userProfile(uid)),
    {
      uid,
      email,
      memberships: { [orgId]: membership ?? FieldValue.delete() },
      updatedAt: now,
    },
    { merge: true },
  );
}

/** Reads all members of an org (call before any writes in the transaction). */
export async function readMembers(
  tx: Transaction,
  db: Firestore,
  orgId: string,
): Promise<MemberDoc[]> {
  const snap = await tx.get(db.collection(paths.members(orgId)));
  return snap.docs.map((d) => d.data() as MemberDoc);
}

/** Pushes an org status/name change to every member's profile index. */
export function fanOutOrgToProfiles(
  tx: Transaction,
  db: Firestore,
  members: MemberDoc[],
  org: { id: string; name: string; status: OrgStatus },
  now: number,
): void {
  for (const m of members) {
    setMembership(tx, db, {
      uid: m.uid,
      email: m.email,
      orgId: org.id,
      membership: { orgName: org.name, orgStatus: org.status, role: m.role },
      now,
    });
  }
}
