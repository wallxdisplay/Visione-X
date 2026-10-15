import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  inSiteScope,
  paths,
  withinLimit,
  type ClaimDeviceInput,
  type DeviceDoc,
  type PublishApprovalDoc,
  type PublishScreensInput,
  type ReviewPublishInput,
  type ScreenDoc,
  type SyncGroupDoc,
  type ScreenRefInput,
  type UpdateScreenInput,
} from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission, requireSiteInScope } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';
import { userAudit } from '../content/media';
import { notify } from '../lib/notify';
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
    requireSiteInScope(member, input.siteId, 'a screen without one of your sites');
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
      rotation: input.rotation ?? 0,
      resolution: input.resolution,
      deviceId: device.id,
      status,
      defaultPlaylistId: null,
      manifestVersion: 0,
      publishedAt: null,
      lastSeen: device.lastSeen,
      device: { manufacturer: device.hardware.manufacturer, model: device.hardware.model, androidVersion: device.hardware.androidVersion },
      health: null,
      pendingCommands: 0,
      offlineAlertedAt: null,
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
    const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'device.authorize');
    const ref = db.doc(paths.screen(input.orgId, input.screenId));
    const screen = (await tx.get(ref)).data() as ScreenDoc | undefined;
    if (!screen) throw new HttpsError('not-found', 'Screen not found.');
    requireSiteInScope(member, screen.siteId, 'this screen');
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
    const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    const ref = db.doc(paths.screen(input.orgId, input.screenId));
    const before = (await tx.get(ref)).data() as ScreenDoc | undefined;
    if (!before) throw new HttpsError('not-found', 'Screen not found.');
    requireSiteInScope(member, before.siteId, 'this screen');
    requireSiteInScope(member, input.siteId, 'the selected site');
    await checkTargets(tx, db, input.orgId, input.siteId, input.groupIds, input.defaultPlaylistId);
    if (input.touch) {
      requireFeature(await readEntitlements(tx, db, input.orgId), 'interactive.touch', 'Touch screens');
      if (before.syncGroupId) throw new HttpsError('failed-precondition', 'A screen in a sync group cannot be a touch screen. Remove it from the group first.');
      if (!(await tx.get(db.doc(paths.layout(input.orgId, input.touch.homeLayoutId)))).exists) {
        throw new HttpsError('invalid-argument', 'The touch home page no longer exists.');
      }
    }
    tx.update(ref, {
      name: input.name,
      siteId: input.siteId,
      groupIds: input.groupIds,
      orientation: input.orientation,
      rotation: input.rotation ?? 0,
      resolution: input.resolution,
      defaultPlaylistId: input.defaultPlaylistId,
      ...(input.touch !== undefined ? { touch: input.touch } : {}),
      updatedAt: at,
    });
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'screen.updated',
      target: { type: 'screen', id: input.screenId },
      data: { name: input.name, defaultPlaylistId: input.defaultPlaylistId, ...(input.touch !== undefined ? { touch: input.touch } : {}) },
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
    const member = await requireOrgPermission(tx, db, actor, input.orgId, 'screen.manage');
    const ref = db.doc(paths.screen(input.orgId, input.screenId));
    const screen = (await tx.get(ref)).data() as ScreenDoc | undefined;
    if (!screen) throw new HttpsError('not-found', 'Screen not found.');
    requireSiteInScope(member, screen.siteId, 'this screen');
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

/** Authorized screens of an org, optionally limited to ids (empty = all). */
export async function authorizedScreens(db: Deps['db'], orgId: string, screenIds: string[] = []): Promise<ScreenDoc[]> {
  const snap = await db.collection(paths.screens(orgId)).where('status', '==', 'authorized').get();
  return snap.docs.map((d) => d.data() as ScreenDoc).filter((s) => screenIds.length === 0 || screenIds.includes(s.id));
}

/**
 * Compiles and stores a fresh manifest for each screen and bumps its version; players notice
 * the new version on their next poll (≤ 30 s) and download it. Used by publish, approvals and
 * emergency overrides.
 */
export async function publishToScreens(deps: Deps, orgId: string, screens: ScreenDoc[]): Promise<number> {
  const { db, now } = deps;
  screens = await withSyncGroupMembers(db, orgId, screens);
  for (const screen of screens) {
    // Re-read so concurrent publishes never reuse a version number.
    const fresh = ((await db.doc(paths.screen(orgId, screen.id)).get()).data() as ScreenDoc | undefined) ?? screen;
    const version = fresh.manifestVersion + 1;
    const manifest = await compileManifest(deps, orgId, fresh, version);
    const at = now();
    const batch = db.batch();
    batch.set(db.doc(paths.screenManifest(orgId, screen.id)), manifest);
    batch.update(db.doc(paths.screen(orgId, screen.id)), { manifestVersion: version, publishedAt: at, updatedAt: at });
    await batch.commit();
  }
  return screens.length;
}

/**
 * A sync group must always run one version of its content, so publishing any member publishes
 * all of them (authorized members only).
 */
async function withSyncGroupMembers(db: Deps['db'], orgId: string, screens: ScreenDoc[]): Promise<ScreenDoc[]> {
  const groupIds = [...new Set(screens.map((s) => s.syncGroupId).filter((g): g is string => !!g))];
  if (!groupIds.length) return screens;
  const have = new Set(screens.map((s) => s.id));
  const groups = await db.getAll(...groupIds.map((g) => db.doc(paths.syncGroup(orgId, g))));
  const extra = [...new Set(groups.flatMap((g) => (g.data() as SyncGroupDoc | undefined)?.members.map((m) => m.screenId) ?? []))].filter((id) => !have.has(id));
  if (!extra.length) return screens;
  const more = (await db.getAll(...extra.map((id) => db.doc(paths.screen(orgId, id))))).map((s) => s.data() as ScreenDoc | undefined);
  return [...screens, ...more.filter((s): s is ScreenDoc => !!s && s.status === 'authorized')];
}

/**
 * Publish to screens. If the org requires approval and the caller cannot approve, this files
 * an approval request instead and publishes nothing yet.
 */
export async function publishScreens(
  deps: Deps,
  actor: Actor,
  input: z.infer<typeof PublishScreensInput> & { note?: string },
): Promise<{ published: number; approvalId?: string }> {
  const { db, now } = deps;
  const { member, org } = await db.runTransaction((tx) =>
    requireActiveOrgPermission(tx, db, actor, input.orgId, 'content.publish'),
  );
  const all = await authorizedScreens(db, input.orgId, input.screenIds);
  // A site-scoped member publishes only to their own sites' screens.
  const scope = member.siteScope ?? [];
  if (scope.length && input.screenIds.length && all.some((s) => !inSiteScope(scope, s.siteId))) {
    throw new HttpsError('permission-denied', 'Your access is limited to some sites; a selected screen is outside them.');
  }
  const screens = all.filter((s) => inSiteScope(scope, s.siteId));
  if (screens.length === 0) throw new HttpsError('failed-precondition', 'There are no authorized screens to publish to.');

  if (org.settings?.requirePublishApproval && !member.permissions.includes('content.approve')) {
    const ref = db.collection(paths.approvals(input.orgId)).doc();
    await auditedTransaction(db, [input.orgId], async (tx, audit) => {
      const approval: PublishApprovalDoc = {
        id: ref.id,
        // Scoped requests name their screens, so approving them never reaches other sites.
        screenIds: scope.length ? screens.map((s) => s.id) : input.screenIds,
        note: input.note ?? null,
        status: 'pending',
        requestedBy: actor.uid,
        requestedByEmail: actor.email,
        requestedAt: now(),
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
      };
      tx.create(ref, approval);
      notify(tx, db, input.orgId, 'approval_requested', { by: actor.email ?? actor.uid, screens: screens.length }, '/screens', now());
      audit(input.orgId, {
        at: now(),
        ...userAudit(actor),
        orgId: input.orgId,
        action: 'publish.requested',
        target: { type: 'approval', id: ref.id },
        data: { screens: screens.length },
      });
    });
    return { published: 0, approvalId: ref.id };
  }

  const published = await publishToScreens(deps, input.orgId, screens);
  await auditedTransaction(db, [input.orgId], async (_tx, audit) => {
    audit(input.orgId, {
      at: now(),
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'content.published',
      target: { type: 'screens', id: input.screenIds.length ? input.screenIds.join(',').slice(0, 200) : 'all' },
      data: { screens: published },
    });
  });
  return { published };
}

/** An approver approves (publishes now) or rejects a pending publish request. */
export async function reviewPublish(
  deps: Deps,
  actor: Actor,
  input: z.infer<typeof ReviewPublishInput>,
): Promise<{ published: number }> {
  const { db, now } = deps;
  const ref = db.doc(paths.approval(input.orgId, input.approvalId));
  const approval = await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    const { member } = await requireActiveOrgPermission(tx, db, actor, input.orgId, 'content.approve');
    const doc = (await tx.get(ref)).data() as PublishApprovalDoc | undefined;
    if (!doc) throw new HttpsError('not-found', 'Approval request not found.');
    if (member.siteScope?.length) {
      const targets = doc.screenIds.length ? await Promise.all(doc.screenIds.map((id) => tx.get(db.doc(paths.screen(input.orgId, id))))) : [];
      if (!doc.screenIds.length || targets.some((t) => !inSiteScope(member.siteScope, (t.data() as ScreenDoc | undefined)?.siteId))) {
        throw new HttpsError('permission-denied', 'This request includes screens outside your sites.');
      }
    }
    if (doc.status !== 'pending') throw new HttpsError('failed-precondition', `This request was already ${doc.status}.`);
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    tx.update(ref, { status, decidedBy: actor.uid, decidedAt: now(), decisionNote: input.note ?? null });
    notify(tx, db, input.orgId, 'approval_decided', { decision: status, by: actor.email ?? actor.uid }, '/screens', now());
    audit(input.orgId, {
      at: now(),
      ...userAudit(actor),
      orgId: input.orgId,
      action: `publish.${status}`,
      target: { type: 'approval', id: input.approvalId },
      ...(input.note ? { reason: input.note } : {}),
    });
    return doc;
  });
  if (input.decision === 'reject') return { published: 0 };
  return { published: await publishToScreens(deps, input.orgId, await authorizedScreens(db, input.orgId, approval.screenIds)) };
}
