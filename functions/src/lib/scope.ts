import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  inSiteScope,
  paths,
  type EmergencyTarget,
  type MemberDoc,
  type ScheduleTarget,
  type ScreenDoc,
  type ScreenGroupDoc,
} from '@wallx-play/shared';

/**
 * A schedule / emergency target is within a site-scoped member's reach only when everything it
 * names belongs to their sites: "all screens" never is; groups count by their site. Unscoped
 * members pass. Reads only (safe before transaction writes).
 */
export async function requireTargetInScope(
  tx: Transaction,
  db: Firestore,
  orgId: string,
  member: Pick<MemberDoc, 'siteScope'>,
  target: ScheduleTarget | EmergencyTarget,
): Promise<void> {
  const scope = member.siteScope ?? [];
  if (scope.length === 0) return;
  let siteIds: Array<string | null>;
  if (target.kind === 'all') siteIds = [null];
  else if (target.kind === 'sites') siteIds = target.ids;
  else {
    const pathFor = target.kind === 'groups' ? paths.screenGroup : paths.screen;
    const snaps = await Promise.all(target.ids.map((id) => tx.get(db.doc(pathFor(orgId, id)))));
    siteIds = snaps.map((s) => (s.data() as ScreenGroupDoc | ScreenDoc | undefined)?.siteId ?? null);
  }
  if (siteIds.some((id) => !inSiteScope(scope, id))) {
    throw new HttpsError('permission-denied', 'Your access is limited to some sites; choose only your sites or their screens.');
  }
}
