import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  paths,
  type EmergencyDoc,
  type EndEmergencyInput,
  type ScreenDoc,
  type TriggerEmergencyInput,
} from '@wallx-play/shared';
import { userAudit } from '../content/media';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';
import { notify } from '../lib/notify';
import { matchesTarget } from '../screens/manifest';
import { authorizedScreens, publishToScreens } from '../screens/screens';

const affected = (screens: ScreenDoc[], e: Pick<EmergencyDoc, 'target'>) => screens.filter((s) => matchesTarget(e.target, s));

/**
 * Takes over the targeted screens immediately (they pick it up on their next poll, ≤ 30 s).
 * Requires the typed confirmation phrase (checked by the input schema) and is audited.
 */
export async function triggerEmergency(
  deps: Deps,
  actor: Actor,
  input: z.infer<typeof TriggerEmergencyInput>,
): Promise<{ emergencyId: string; screens: number }> {
  const { db, now } = deps;
  const at = now();
  const ref = db.collection(paths.emergencies(input.orgId)).doc();
  const screens = await authorizedScreens(db, input.orgId);

  const emergency = await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'emergency.trigger');
    requireFeature(await readEntitlements(tx, db, input.orgId), 'emergency.override', 'Emergency override');
    if (input.content.kind === 'playlist') {
      const playlist = await tx.get(db.doc(paths.playlist(input.orgId, input.content.playlistId)));
      if (!playlist.exists) throw new HttpsError('invalid-argument', 'The selected playlist no longer exists.');
    }
    const doc: EmergencyDoc = {
      id: ref.id,
      name: input.name,
      content: input.content,
      target: input.target,
      active: true,
      startedAt: at,
      expiresAt: input.durationMinutes ? at + input.durationMinutes * 60_000 : null,
      endedAt: null,
      startedBy: actor.uid,
      startedByEmail: actor.email,
      endedBy: null,
      screenCount: 0,
    };
    doc.screenCount = affected(screens, doc).length;
    if (doc.screenCount === 0) throw new HttpsError('failed-precondition', 'No authorized screens match this target.');
    tx.create(ref, doc);
    notify(tx, db, input.orgId, 'emergency_started', { name: doc.name, screens: doc.screenCount, by: actor.email ?? actor.uid }, '/screens', at);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'emergency.started',
      target: { type: 'emergency', id: ref.id },
      data: { name: doc.name, content: doc.content.kind, target: doc.target.kind, screens: doc.screenCount, expiresAt: doc.expiresAt },
    });
    return doc;
  });

  await publishToScreens(deps, input.orgId, affected(screens, emergency));
  return { emergencyId: ref.id, screens: emergency.screenCount };
}

/** Ends an override and republishes normal content to the affected screens. */
export async function endEmergency(
  deps: Deps,
  actor: Actor | null,
  input: z.infer<typeof EndEmergencyInput>,
): Promise<{ screens: number }> {
  const { db, now } = deps;
  const at = now();
  const ref = db.doc(paths.emergency(input.orgId, input.emergencyId));
  const emergency = await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    if (actor) await requireOrgPermission(tx, db, actor, input.orgId, 'emergency.trigger');
    const doc = (await tx.get(ref)).data() as EmergencyDoc | undefined;
    if (!doc) throw new HttpsError('not-found', 'Emergency not found.');
    if (!doc.active) throw new HttpsError('failed-precondition', 'This emergency has already ended.');
    tx.update(ref, { active: false, endedAt: at, endedBy: actor?.uid ?? 'system' });
    notify(tx, db, input.orgId, 'emergency_ended', { name: doc.name, by: actor ? (actor.email ?? actor.uid) : 'schedule' }, '/screens', at);
    audit(input.orgId, {
      at,
      ...(actor ? userAudit(actor) : { actorType: 'system' as const, actorId: 'emergency-expiry' }),
      orgId: input.orgId,
      action: actor ? 'emergency.ended' : 'emergency.expired',
      target: { type: 'emergency', id: input.emergencyId },
      data: { name: doc.name },
    });
    return doc;
  });
  const screens = affected(await authorizedScreens(db, input.orgId), emergency);
  await publishToScreens(deps, input.orgId, screens);
  return { screens: screens.length };
}
