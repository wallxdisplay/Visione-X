/**
 * Daily retention: removes operational records nobody needs after a while, and releases the
 * storage quota of uploads that never finished. Customer history (alerts, approvals,
 * emergencies, payments) and the audit log are kept; the audit log is also exported daily
 * (auditExport.ts). Sensor readings and provider cache entries expire through Firestore TTL.
 */
import { FieldValue, type DocumentReference, type Query } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REGION, paths, type InviteDoc, type MediaDoc, type ScreenCommandDoc } from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import { getDeps } from '../lib/admin';
import type { Deps } from '../lib/context';

const DAY = 86_400_000;

/** How long each kind of record is kept (after it was created, or after it expired). */
export const RETENTION = {
  /** Pairing codes, after they expired. */
  pairingCodesDays: 1,
  /** Invitations (any status), after they expired. */
  invitesDays: 30,
  /** Remote commands and their screenshots, after they were sent. */
  commandsDays: 30,
  /** In-app notifications, after they were created. */
  notificationsDays: 90,
  /** Media uploads that never finished; their reserved storage is given back. */
  abandonedUploadsDays: 1,
  /** Player release uploads that never finished or were rejected. */
  playerUploadsDays: 7,
} as const;

/** Upper bound per kind and run; anything left is picked up the next day. */
const MAX_PER_KIND = 2000;
const BATCH = 400;

export interface RetentionResult {
  pairingCodes: number;
  invites: number;
  commands: number;
  screenshots: number;
  notifications: number;
  abandonedUploads: number;
  playerUploads: number;
}

/** Deletes the documents a query returns (in pages), running `extra` on each first. */
async function purge(deps: Deps, query: Query, extra?: (data: FirebaseFirestore.DocumentData, ref: DocumentReference) => Promise<void> | void): Promise<number> {
  let total = 0;
  while (total < MAX_PER_KIND) {
    const snap = await query.limit(Math.min(BATCH, MAX_PER_KIND - total)).get();
    if (snap.empty) break;
    const batch = deps.db.batch();
    for (const d of snap.docs) {
      await extra?.(d.data(), d.ref);
      batch.delete(d.ref);
    }
    await batch.commit();
    total += snap.size;
    if (snap.size < BATCH) break;
  }
  return total;
}

export async function runRetention(deps: Deps): Promise<RetentionResult> {
  const { db, bucket, now } = deps;
  const at = now();
  const before = (days: number) => at - days * DAY;
  let screenshots = 0;

  const pairingCodes = await purge(deps, db.collection('pairingCodes').where('expiresAt', '<', before(RETENTION.pairingCodesDays)));

  const invites = await purge(deps, db.collectionGroup('invites').where('expiresAt', '<', before(RETENTION.invitesDays)), async (data) => {
    const invite = data as InviteDoc;
    await db.doc(paths.inviteToken(invite.tokenHash)).delete();
  });

  const commands = await purge(deps, db.collectionGroup('commands').where('createdAt', '<', before(RETENTION.commandsDays)), async (data) => {
    const path = (data as ScreenCommandDoc).screenshotPath;
    if (path) {
      await bucket.file(path).delete({ ignoreNotFound: true });
      screenshots += 1;
    }
  });

  const notifications = await purge(deps, db.collectionGroup('notifications').where('createdAt', '<', before(RETENTION.notificationsDays)));

  // Abandoned media uploads: give back the storage the reservation counted (audited per org).
  let abandonedUploads = 0;
  const stale = await db
    .collectionGroup('media')
    .where('status', '==', 'uploading')
    .where('createdAt', '<', before(RETENTION.abandonedUploadsDays))
    .limit(200)
    .get();
  for (const d of stale.docs) {
    const orgId = d.ref.parent.parent!.id;
    const released = await auditedTransaction(db, [orgId], async (tx, audit) => {
      const media = (await tx.get(d.ref)).data() as MediaDoc | undefined;
      if (!media || media.status !== 'uploading') return false;
      tx.delete(d.ref);
      tx.set(db.doc(paths.orgUsage(orgId)), { storageBytes: FieldValue.increment(-media.storedBytes), updatedAt: at }, { merge: true });
      audit(orgId, {
        at,
        actorType: 'system',
        actorId: 'retention',
        orgId,
        action: 'media.upload.abandoned',
        target: { type: 'media', id: d.id },
        data: { name: media.name, bytes: media.storedBytes },
      });
      return true;
    });
    if (released) {
      await bucket.deleteFiles({ prefix: `orgs/${orgId}/media/${d.id}/` });
      abandonedUploads += 1;
    }
  }

  const playerUploads = await purge(
    deps,
    db.collection(paths.playerReleases()).where('status', 'in', ['uploading', 'failed']).where('createdAt', '<', before(RETENTION.playerUploadsDays)),
    async (_data, ref) => {
      await bucket.file(paths.playerApk(ref.id)).delete({ ignoreNotFound: true });
    },
  );

  return { pairingCodes, invites, commands, screenshots, notifications, abandonedUploads, playerUploads };
}

export const retentionDaily = onSchedule(
  { schedule: '30 3 * * *', region: REGION, timeZone: 'Asia/Kolkata', memory: '512MiB', timeoutSeconds: 540, maxInstances: 1, retryCount: 1 },
  async () => {
    logger.info('Retention run', await runRetention(getDeps()));
  },
);
