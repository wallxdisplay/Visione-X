import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  paths,
  withinLimit,
  type ClaimDeviceInput,
  type DeviceDoc,
  type PublishScreensInput,
  type ScreenDoc,
  type ScreenRefInput,
  type UpdateScreenInput,
} from '@visione-x/shared';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements } from '../lib/entitlements';
import { userAudit } from '../content/media';
import { compileManifest } from './manifest';

async function checkTargets(
  tx: Transaction,
  db: Deps['db'],
  orgId: string,
  siteId: string | null,
  groupIds: string[],
  playlistId?: string | null,
) {
  const refs = [
    ...(siteId ? [db.doc(paths.site(orgId, siteId))] : []),
    ...groupIds.map((g) => db.doc(paths.screenGroup(orgId, g))),
    ...(playlistId ? [db.doc(paths.playlist(orgId, playlistId))] : []),
  ];
  const snaps = await Promise.all(refs.map((r) => tx.get(r)));
  if (snaps.some((s) => !s.exists)) {
    throw new HttpsError('invalid-argument', 'A selected site, group or playlist no longer exists.');
  }
}

/**
 * Links a player (shown on screen as a pairing code) to this org as a new screen. Members with
 * device.authorize activate it immediately; otherwise it waits for an admin to authorize it.
 */
export async function claimDevice(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof ClaimDeviceInput>,
): Promise<{ screenId: string; status: ScreenDoc['status'] }> {
  const at = now();
  const screenRef = db.collection(paths.screens(input.orgId)).doc();
  return auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    const entitlements = await readEntitlements(tx, db, input.orgId);
    const codeRef = db.doc(paths.pairingCode(input.pairingCode));
    const code = (await tx.get(codeRef)).data() as { deviceId: string; expiresAt: number } | undefined;
    if (!code || code.expiresAt <= at) {
      throw new HttpsError('not-found', 'This pairing code is invalid or has expired. Check the code shown on the screen.');
    }
    const deviceRef = db.doc(paths.device(code.deviceId));
    const device = (await tx.get(deviceRef)).data() as DeviceDoc | undefined;
    if (!device || device.status !== 'unpaired') {
      throw new HttpsError('failed-precondition', 'This player is already paired.');
    }
    if (device.pairingCode !== input.pairingCode) {
      throw new HttpsError('not-found', 'This pairing code is invalid or has expired. Check the code shown on the screen.');
    }
    const existing = await tx.get(db.collection(paths.screens(input.orgId)).count());
    if (!withinLimit(entitlements.limits, 'screens', existing.data().count + 1)) {
      throw new HttpsError('resource-exhausted', 'Your plan’s screen limit has been reached.');
    }
    await checkTargets(tx, db, input.orgId, input.siteId, input.groupIds);

    const status: ScreenDoc['status'] = member.permissions.includes('device.authorize') ? 'authorized' : 'pending_authorization';
    const screen: ScreenDoc = {
      id: screenRef.id,
      name: input.name,
      siteId: input.siteId,
      groupIds: input.groupIds,
      orientation: input.orientation,
      resolution: input.resolution,
      deviceId: device.id,
      status,
      defaultPlaylistId: null,
      manifestVersion: 0,
      publishedAt: null,
      lastSeen: device.lastSeen,
      device: { manufacturer: device.hardware.manufacturer, model: device.hardware.model, androidVersion: device.hardware.androidVersion },
      health: null,
      createdBy: actor.uid,
      createdAt: at,
      updatedAt: at,
    };
    tx.create(screenRef, screen);
    tx.update(deviceRef, {
      status,
      orgId: input.orgId,
      screenId: screenRef.id,
      pairingCode: null,
      pairingExpiresAt: null,
      updatedAt: at,
    });
    tx.delete(codeRef);
    tx.set(db.doc(paths.orgUsage(input.orgId)), { screens: FieldValue.increment(1), updatedAt: at }, { merge: true });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'screen.paired',
      target: { type: 'screen', id: screenRef.id },
      data: { name: input.name, deviceId: device.id, model: device.hardware.model, status },
    });
    return { screenId: screenRef.id, status };
  });
}

export async function authorizeScreen(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof ScreenRefInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'device.authorize');
    const ref = db.doc(paths.screen(input.orgId, input.screenId));
    const screen = (await tx.get(ref)).data() as ScreenDoc | undefined;
    if (!screen) throw new HttpsError('not-found', 'Screen not found.');
    if (screen.status !== 'pending_authorization' || !screen.deviceId) {
      throw new HttpsError('failed-precondition', 'This screen is not waiting for authorization.');
    }
    tx.update(ref, { status: 'authorized', updatedAt: at });
    tx.update(db.doc(paths.device(screen.deviceId)), { status: 'authorized', updatedAt: at });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'screen.authorized',
      target: { type: 'screen', id: input.screenId },
      data: { name: screen.name },
    });
  });
}

export async function updateScreen(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof UpdateScreenInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    const ref = db.doc(paths.screen(input.orgId, input.screenId));
    const before = (await tx.get(ref)).data() as ScreenDoc | undefined;
    if (!before) throw new HttpsError('not-found', 'Screen not found.');
    await checkTargets(tx, db, input.orgId, input.siteId, input.groupIds, input.defaultPlaylistId);
    tx.update(ref, {
      name: input.name,
      siteId: input.siteId,
      groupIds: input.groupIds,
      orientation: input.orientation,
      resolution: input.resolution,
      defaultPlaylistId: input.defaultPlaylistId,
      updatedAt: at,
    });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'screen.updated',
      target: { type: 'screen', id: input.screenId },
      data: { name: input.name, defaultPlaylistId: input.defaultPlaylistId },
    });
  });
}

/** Removes the screen and permanently revokes its player (it must be registered again). */
export async function removeScreen(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof ScreenRefInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    const ref = db.doc(paths.screen(input.orgId, input.screenId));
    const screen = (await tx.get(ref)).data() as ScreenDoc | undefined;
    if (!screen) throw new HttpsError('not-found', 'Screen not found.');
    tx.delete(ref);
    tx.delete(db.doc(paths.screenManifest(input.orgId, input.screenId)));
    if (screen.deviceId) tx.update(db.doc(paths.device(screen.deviceId)), { status: 'revoked', updatedAt: at });
    tx.set(db.doc(paths.orgUsage(input.orgId)), { screens: FieldValue.increment(-1), updatedAt: at }, { merge: true });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'screen.removed',
      target: { type: 'screen', id: input.screenId },
      data: { name: screen.name, deviceId: screen.deviceId },
    });
  });
}

/**
 * Compiles and stores a fresh manifest for each target screen and bumps its version; players
 * notice the new version on their next poll and download it.
 */
export async function publishScreens(
  deps: Deps,
  actor: Actor,
  input: z.infer<typeof PublishScreensInput>,
): Promise<{ published: number }> {
  const { db, now } = deps;
  const screens = await db.runTransaction(async (tx) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'content.publish');
    const snap = await tx.get(db.collection(paths.screens(input.orgId)).where('status', '==', 'authorized'));
    return snap.docs
      .map((d) => d.data() as ScreenDoc)
      .filter((s) => input.screenIds.length === 0 || input.screenIds.includes(s.id));
  });
  if (screens.length === 0) throw new HttpsError('failed-precondition', 'There are no authorized screens to publish to.');

  for (const screen of screens) {
    const version = screen.manifestVersion + 1;
    const manifest = await compileManifest(deps, input.orgId, screen, version);
    const at = now();
    const batch = db.batch();
    batch.set(db.doc(paths.screenManifest(input.orgId, screen.id)), manifest);
    batch.update(db.doc(paths.screen(input.orgId, screen.id)), { manifestVersion: version, publishedAt: at, updatedAt: at });
    await batch.commit();
  }

  await auditedTransaction(db, [input.orgId], async (_tx, audit) => {
    audit(input.orgId, {
      at: now(),
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'content.published',
      target: { type: 'screens', id: input.screenIds.length ? input.screenIds.join(',').slice(0, 200) : 'all' },
      data: { screens: screens.length },
    });
  });
  return { published: screens.length };
}
