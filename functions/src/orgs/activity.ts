/**
 * The organization's activity log for its members (audit.view): what happened, when and by whom,
 * from the tamper-evident audit chain. Served by a function rather than opened in the rules so
 * customers never see internal fields: no data payloads, and WallX staff's notes only on support
 * access (the customer is told why support asked) — billing notes stay internal.
 */
import type { z } from 'zod';
import { ACTIVITY_PAGE, paths, type ActivityEntry, type AuditDoc, type OrgActivityInput } from '@wallx-play/shared';
import { requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';

export async function orgActivity({ db }: Deps, actor: Actor, input: z.infer<typeof OrgActivityInput>): Promise<{ entries: ActivityEntry[]; more: boolean }> {
  await db.runTransaction((tx) => requireOrgPermission(tx, db, actor, input.orgId, 'audit.view'));
  let q = db.collection(paths.auditLogs()).where('orgId', '==', input.orgId).orderBy('at', 'desc');
  if (input.before) q = q.startAfter(input.before);
  const snap = await q.limit(ACTIVITY_PAGE + 1).get();
  const docs = snap.docs.slice(0, ACTIVITY_PAGE).map((d) => d.data() as AuditDoc);
  return {
    entries: docs.map((d) => ({
      at: d.at,
      actorType: d.actorType,
      // Staff are shown as WallX (their own email stays internal).
      actorEmail: d.actorType === 'user' ? (d.actorEmail ?? null) : null,
      action: d.action,
      target: d.target,
      reason: d.reason && (d.actorType !== 'platform_user' || d.action.startsWith('support.')) ? d.reason : null,
    })),
    more: snap.size > ACTIVITY_PAGE,
  };
}
