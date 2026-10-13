import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  paths,
  type DeleteScheduleInput,
  type DeleteScreenGroupInput,
  type SaveScheduleInput,
  type ScheduleDoc,
  type ScreenGroupDoc,
  type UpsertScreenGroupInput,
} from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission, requireSiteInScope } from '../lib/authz';
import { requireTargetInScope } from '../lib/scope';
import type { Actor, Deps } from '../lib/context';
import { userAudit } from './media';

export async function upsertScreenGroup(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof UpsertScreenGroupInput>,
): Promise<{ groupId: string }> {
  const at = now();
  const ref = input.groupId
    ? db.doc(paths.screenGroup(input.orgId, input.groupId))
    : db.collection(paths.screenGroups(input.orgId)).doc();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    const existing = input.groupId ? await tx.get(ref) : null;
    if (existing && !existing.exists) throw new HttpsError('not-found', 'Group not found.');
    if (existing) requireSiteInScope(member, (existing.data() as ScreenGroupDoc).siteId, 'this group');
    requireSiteInScope(member, input.siteId, 'a group without one of your sites');
    if (input.siteId && !(await tx.get(db.doc(paths.site(input.orgId, input.siteId)))).exists) {
      throw new HttpsError('not-found', 'Site not found.');
    }
    const doc: ScreenGroupDoc = {
      id: ref.id,
      name: input.name,
      siteId: input.siteId,
      ...(input.description ? { description: input.description } : {}),
      createdAt: (existing?.data() as ScreenGroupDoc | undefined)?.createdAt ?? at,
      updatedAt: at,
    };
    tx.set(ref, doc);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: existing ? 'screenGroup.updated' : 'screenGroup.created',
      target: { type: 'screenGroup', id: ref.id },
      data: { name: input.name },
    });
  });
  return { groupId: ref.id };
}

export async function deleteScreenGroup(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof DeleteScreenGroupInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const member = await requireOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    const ref = db.doc(paths.screenGroup(input.orgId, input.groupId));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Group not found.');
    requireSiteInScope(member, (snap.data() as ScreenGroupDoc).siteId, 'this group');
    const [screens, schedules] = await Promise.all([
      tx.get(db.collection(paths.screens(input.orgId)).where('groupIds', 'array-contains', input.groupId).limit(1)),
      tx.get(db.collection(paths.schedules(input.orgId)).where('target.ids', 'array-contains', input.groupId).limit(1)),
    ]);
    if (!screens.empty) throw new HttpsError('failed-precondition', 'Remove the screens from this group first.');
    if (!schedules.empty) {
      throw new HttpsError(
        'failed-precondition',
        `Schedule “${(schedules.docs[0]!.data() as ScheduleDoc).name}” targets this group. Change it first.`,
      );
    }
    tx.delete(ref);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'screenGroup.deleted',
      target: { type: 'screenGroup', id: input.groupId },
      data: { name: (snap.data() as ScreenGroupDoc).name },
    });
  });
}

export async function saveSchedule(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SaveScheduleInput>,
): Promise<{ scheduleId: string }> {
  const at = now();
  const ref = input.scheduleId
    ? db.doc(paths.schedule(input.orgId, input.scheduleId))
    : db.collection(paths.schedules(input.orgId)).doc();

  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'schedule.edit');
    const existing = input.scheduleId ? await tx.get(ref) : null;
    if (existing && !existing.exists) throw new HttpsError('not-found', 'Schedule not found.');
    if (existing) await requireTargetInScope(tx, db, input.orgId, member, (existing.data() as ScheduleDoc).target);
    await requireTargetInScope(tx, db, input.orgId, member, input.target);
    if (!(await tx.get(db.doc(paths.playlist(input.orgId, input.playlistId)))).exists) {
      throw new HttpsError('invalid-argument', 'The selected playlist no longer exists.');
    }
    if (input.target.kind !== 'all') {
      const pathFor = input.target.kind === 'sites' ? paths.site : paths.screenGroup;
      const snaps = await Promise.all(input.target.ids.map((id) => tx.get(db.doc(pathFor(input.orgId, id)))));
      if (snaps.some((s) => !s.exists)) {
        throw new HttpsError('invalid-argument', `A selected ${input.target.kind === 'sites' ? 'site' : 'group'} no longer exists.`);
      }
    }

    const previous = existing?.data() as ScheduleDoc | undefined;
    const doc: ScheduleDoc = {
      id: ref.id,
      name: input.name,
      playlistId: input.playlistId,
      target: input.target,
      priority: input.priority,
      timezone: input.timezone,
      startDate: input.startDate,
      endDate: input.endDate,
      daysOfWeek: [...new Set(input.daysOfWeek)].sort(),
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      enabled: input.enabled,
      createdBy: previous?.createdBy ?? actor.uid,
      createdAt: previous?.createdAt ?? at,
      updatedBy: actor.uid,
      updatedAt: at,
    };
    tx.set(ref, doc);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: previous ? 'schedule.updated' : 'schedule.created',
      target: { type: 'schedule', id: ref.id },
      data: { name: doc.name, playlistId: doc.playlistId, priority: doc.priority, enabled: doc.enabled },
    });
  });
  return { scheduleId: ref.id };
}

export async function deleteSchedule(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof DeleteScheduleInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const member = await requireOrgPermission(tx, db, actor, input.orgId, 'schedule.edit');
    const ref = db.doc(paths.schedule(input.orgId, input.scheduleId));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Schedule not found.');
    await requireTargetInScope(tx, db, input.orgId, member, (snap.data() as ScheduleDoc).target);
    tx.delete(ref);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'schedule.deleted',
      target: { type: 'schedule', id: input.scheduleId },
      data: { name: (snap.data() as ScheduleDoc).name },
    });
  });
}
