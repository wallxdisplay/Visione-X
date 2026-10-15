/**
 * Sync groups (multi-screen sync, Enterprise): several screens play one playlist on a shared
 * timeline, mirrored or as a video wall. A screen belongs to at most one group (screen.syncGroupId).
 * Saving resets the group's timeline anchor and republishes its members (and screens that left).
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import { paths, type SaveSyncGroupInput, type ScreenDoc, type SyncGroupDoc, type SyncGroupRefInput } from '@wallx-play/shared';
import { userAudit } from '../content/media';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission, requireSiteInScope } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';
import { publishToScreens } from './screens';

export async function saveSyncGroup(deps: Deps, actor: Actor, input: z.infer<typeof SaveSyncGroupInput>): Promise<{ groupId: string; published: number }> {
  const { db, now } = deps;
  const at = now();
  const ref = input.groupId ? db.doc(paths.syncGroup(input.orgId, input.groupId)) : db.collection(paths.syncGroups(input.orgId)).doc();
  const wall = input.mode === 'wall';
  const members = input.members.map((m) => (wall ? m : { screenId: m.screenId, row: 0, col: 0 }));

  const { affected } = await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    requireFeature(await readEntitlements(tx, db, input.orgId), 'screen.multiSync', 'Multi-screen sync');
    const before = input.groupId ? ((await tx.get(ref)).data() as SyncGroupDoc | undefined) : undefined;
    if (input.groupId && !before) throw new HttpsError('not-found', 'Sync group not found.');
    if (!(await tx.get(db.doc(paths.playlist(input.orgId, input.playlistId)))).exists) {
      throw new HttpsError('invalid-argument', 'The selected playlist no longer exists.');
    }
    const snaps = await tx.getAll(...members.map((m) => db.doc(paths.screen(input.orgId, m.screenId))));
    const screens = snaps.map((s) => s.data() as ScreenDoc | undefined);
    screens.forEach((s, i) => {
      if (!s) throw new HttpsError('not-found', `Screen ${members[i]!.screenId} not found.`);
      if (s.status !== 'authorized') throw new HttpsError('failed-precondition', `Authorize “${s.name}” before adding it to a sync group.`);
      requireSiteInScope(member, s.siteId, `“${s.name}”`);
      if (s.syncGroupId && s.syncGroupId !== ref.id) throw new HttpsError('failed-precondition', `“${s.name}” is already in another sync group.`);
    });
    const leaving = (before?.members ?? []).map((m) => m.screenId).filter((id) => !members.some((m) => m.screenId === id));

    const doc: SyncGroupDoc = {
      id: ref.id,
      name: input.name,
      mode: input.mode,
      playlistId: input.playlistId,
      rows: wall ? input.rows : 1,
      cols: wall ? input.cols : 1,
      members,
      enabled: input.enabled,
      // Whole seconds: every member counts the same timeline from here.
      anchor: at - (at % 1000),
      createdBy: before?.createdBy ?? actor.uid,
      createdAt: before?.createdAt ?? at,
      updatedAt: at,
    };
    tx.set(ref, doc);
    for (const m of members) tx.update(db.doc(paths.screen(input.orgId, m.screenId)), { syncGroupId: ref.id, updatedAt: at });
    for (const id of leaving) tx.update(db.doc(paths.screen(input.orgId, id)), { syncGroupId: null, updatedAt: at });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: before ? 'syncGroup.updated' : 'syncGroup.created',
      target: { type: 'syncGroup', id: ref.id },
      data: { name: input.name, mode: input.mode, playlistId: input.playlistId, screens: members.length, enabled: input.enabled, ...(wall ? { grid: `${input.cols}x${input.rows}` } : {}) },
    });
    return { affected: [...members.map((m) => m.screenId), ...leaving] };
  });

  const published = await republish(deps, input.orgId, affected);
  return { groupId: ref.id, published };
}

export async function deleteSyncGroup(deps: Deps, actor: Actor, input: z.infer<typeof SyncGroupRefInput>): Promise<{ published: number }> {
  const { db, now } = deps;
  const ref = db.doc(paths.syncGroup(input.orgId, input.groupId));
  const affected = await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    const group = (await tx.get(ref)).data() as SyncGroupDoc | undefined;
    if (!group) throw new HttpsError('not-found', 'Sync group not found.');
    const ids = group.members.map((m) => m.screenId);
    const snaps = await tx.getAll(...ids.map((id) => db.doc(paths.screen(input.orgId, id))));
    snaps.forEach((s) => {
      if (s.exists && (s.data() as ScreenDoc).syncGroupId === group.id) tx.update(s.ref, { syncGroupId: null, updatedAt: now() });
    });
    tx.delete(ref);
    audit(input.orgId, { at: now(), ...userAudit(actor), orgId: input.orgId, action: 'syncGroup.deleted', target: { type: 'syncGroup', id: group.id }, data: { name: group.name } });
    return ids;
  });
  return { published: await republish(deps, input.orgId, affected) };
}

/** Republishes the authorized screens among `ids` so they pick up (or leave) the group. */
async function republish(deps: Deps, orgId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const snaps = await deps.db.getAll(...[...new Set(ids)].map((id) => deps.db.doc(paths.screen(orgId, id))));
  const screens = snaps.map((s) => s.data() as ScreenDoc | undefined).filter((s): s is ScreenDoc => !!s && s.status === 'authorized');
  return publishToScreens(deps, orgId, screens);
}
