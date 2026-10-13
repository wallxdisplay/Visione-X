import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  CommandResultBody,
  DISRUPTIVE_COMMANDS,
  hasPlatformPermission,
  paths,
  type MarkNotificationsReadInput,
  type ScreenCommandDoc,
  type ScreenDoc,
  type SendScreenCommandInput,
} from '@wallx-play/shared';
import { userAudit } from '../content/media';
import { auditedTransaction, platformAudit } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission, requireSiteInScope } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';

/**
 * Queues a command for a screen's player (delivered on its next poll). Org members need
 * screen.command (and the plan feature); WallX staff with the platform permission
 * device.command may send any command for troubleshooting, always audited.
 */
export async function sendScreenCommand(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SendScreenCommandInput>,
): Promise<{ commandId: string }> {
  const at = now();
  const screenRef = db.doc(paths.screen(input.orgId, input.screenId));
  const ref = db.collection(paths.commands(input.orgId, input.screenId)).doc();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const staff = hasPlatformPermission(actor.platformRole, 'device.command');
    if (!staff) {
      const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'screen.command');
      requireFeature(await readEntitlements(tx, db, input.orgId), 'screen.remoteCommands', 'Remote commands');
      requireSiteInScope(member, ((await tx.get(screenRef)).data() as ScreenDoc | undefined)?.siteId, 'this screen');
    }
    const screen = (await tx.get(screenRef)).data() as ScreenDoc | undefined;
    if (!screen) throw new HttpsError('not-found', 'Screen not found.');
    if (screen.status !== 'authorized') throw new HttpsError('failed-precondition', 'Authorize the screen first.');
    const command: ScreenCommandDoc = {
      id: ref.id,
      type: input.type,
      status: 'pending',
      createdBy: actor.uid,
      createdAt: at,
      deliveredAt: null,
      completedAt: null,
      result: null,
      screenshotPath: null,
    };
    tx.create(ref, command);
    tx.update(screenRef, { pendingCommands: FieldValue.increment(1) });
    if (staff || DISRUPTIVE_COMMANDS.includes(input.type)) {
      audit(input.orgId, {
        at,
        ...(staff ? platformAudit(actor) : userAudit(actor)),
        orgId: input.orgId,
        action: `screen.command.${input.type}`,
        target: { type: 'screen', id: input.screenId },
        data: { name: screen.name },
      });
    }
  });
  return { commandId: ref.id };
}

/** Device side: fetch pending commands (marks them delivered). */
export async function takePendingCommands(
  { db, now }: Deps,
  orgId: string,
  screenId: string,
): Promise<Array<Pick<ScreenCommandDoc, 'id' | 'type' | 'createdAt'>>> {
  const at = now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(
      db.collection(paths.commands(orgId, screenId)).where('status', '==', 'pending').limit(10),
    );
    // Recount instead of decrementing so the counter heals itself after any drift.
    // (All reads happen before the writes, as transactions require.)
    const total = await tx.get(db.collection(paths.commands(orgId, screenId)).where('status', '==', 'pending').count());
    const commands = snap.docs.map((d) => d.data() as ScreenCommandDoc).sort((a, b) => a.createdAt - b.createdAt);
    for (const c of commands) tx.update(db.doc(paths.command(orgId, screenId, c.id)), { status: 'delivered', deliveredAt: at });
    tx.update(db.doc(paths.screen(orgId, screenId)), {
      pendingCommands: Math.max(0, total.data().count - commands.length),
    });
    return commands.map(({ id, type, createdAt }) => ({ id, type, createdAt }));
  });
}

/** Device side: report a command result; a screenshot is stored for org members to view. */
export async function completeCommand(
  { db, bucket, now }: Deps,
  orgId: string,
  screenId: string,
  body: z.infer<typeof CommandResultBody>,
): Promise<boolean> {
  const ref = db.doc(paths.command(orgId, screenId, body.id));
  const existing = (await ref.get()).data() as ScreenCommandDoc | undefined;
  if (!existing || existing.status === 'done' || existing.status === 'failed') return false;

  let screenshotPath: string | null = null;
  if (body.screenshotJpegBase64) {
    const bytes = Buffer.from(body.screenshotJpegBase64, 'base64');
    // JPEG magic number check: never store arbitrary uploads.
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      screenshotPath = `orgs/${orgId}/screenshots/${screenId}/${body.id}.jpg`;
      await bucket.file(screenshotPath).save(bytes, { contentType: 'image/jpeg', resumable: false });
    }
  }
  await ref.update({ status: body.status, completedAt: now(), result: body.result ?? null, screenshotPath });
  return true;
}

export async function markNotificationsRead(
  { db }: Deps,
  actor: Actor,
  input: z.infer<typeof MarkNotificationsReadInput>,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'screen.view');
    for (const id of input.notificationIds) {
      tx.update(db.doc(`${paths.notifications(input.orgId)}/${id}`), { readBy: FieldValue.arrayUnion(actor.uid) });
    }
  });
}
