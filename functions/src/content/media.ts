import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  MEDIA_LIMITS,
  mediaStoragePath,
  mediaTypeForMime,
  paths,
  type CreateMediaUploadInput,
  type DeleteFolderInput,
  type DeleteMediaInput,
  type FolderDoc,
  type LayoutDoc,
  type MediaDoc,
  type PlaylistDoc,
  type UpdateMediaInput,
  type UpsertFolderInput,
} from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';

const GIB = 1024 ** 3;

export function userAudit(actor: Actor) {
  return {
    actorType: actor.apiKey ? ('api_key' as const) : ('user' as const),
    actorId: actor.uid,
    ...(actor.email ? { actorEmail: actor.email } : {}),
  };
}

/**
 * Reserves a media item before the browser uploads the file. The Storage rules only accept an
 * upload to `uploadPath` while this document is in `uploading` state, from the same user, with
 * the declared type and at most the declared size. Quota is reserved now and corrected after
 * processing.
 */
export async function createMediaUpload(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof CreateMediaUploadInput>,
): Promise<{ mediaId: string; uploadPath: string }> {
  const type = mediaTypeForMime(input.mimeType);
  if (!type) throw new HttpsError('invalid-argument', 'This file type is not supported.');
  const limit = MEDIA_LIMITS[type].maxBytes;
  if (input.bytes > limit) {
    throw new HttpsError(
      'invalid-argument',
      `This file is too large. The limit for ${type} files is ${Math.round(limit / 1024 / 1024)} MB.`,
    );
  }

  const ref = db.collection(paths.mediaCol(input.orgId)).doc();
  const uploadPath = mediaStoragePath(input.orgId, ref.id, 'original');
  const at = now();

  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'media.upload');
    const entitlements = await readEntitlements(tx, db, input.orgId);
    requireFeature(entitlements, 'media.basic', 'Media uploads');
    const usage = (await tx.get(db.doc(paths.orgUsage(input.orgId)))).data() ?? {};
    const usedBytes = Number(usage.storageBytes ?? 0);
    const limitGb = entitlements.limits.storageGB;
    if (limitGb !== null && usedBytes + input.bytes > limitGb * GIB) {
      throw new HttpsError('resource-exhausted', `Your plan’s storage limit (${limitGb} GB) would be exceeded.`);
    }
    if (input.folderId) {
      const folder = await tx.get(db.doc(paths.folder(input.orgId, input.folderId)));
      if (!folder.exists) throw new HttpsError('not-found', 'Folder not found.');
    }

    const media: MediaDoc = {
      id: ref.id,
      name: input.name,
      type,
      status: 'uploading',
      mimeType: input.mimeType,
      bytes: input.bytes,
      storedBytes: input.bytes,
      originalPath: uploadPath,
      folderId: input.folderId ?? null,
      tags: [],
      createdBy: actor.uid,
      createdAt: at,
      updatedAt: at,
    };
    tx.create(ref, media);
    tx.set(
      db.doc(paths.orgUsage(input.orgId)),
      { storageBytes: FieldValue.increment(input.bytes), updatedAt: at },
      { merge: true },
    );
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'media.created',
      target: { type: 'media', id: ref.id },
      data: { name: input.name, type, bytes: input.bytes },
    });
  });
  return { mediaId: ref.id, uploadPath };
}

export async function updateMedia(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof UpdateMediaInput>,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'media.upload');
    const ref = db.doc(paths.media(input.orgId, input.mediaId));
    if (!(await tx.get(ref)).exists) throw new HttpsError('not-found', 'Media not found.');
    if (input.folderId) {
      const folder = await tx.get(db.doc(paths.folder(input.orgId, input.folderId)));
      if (!folder.exists) throw new HttpsError('not-found', 'Folder not found.');
    }
    tx.update(ref, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      ...(input.tags !== undefined ? { tags: [...new Set(input.tags)] } : {}),
      updatedAt: now(),
    });
  });
}

/** Names of layouts/playlists that use a media item (empty = safe to delete). */
async function mediaUsage(
  tx: Transaction,
  db: Deps['db'],
  orgId: string,
  mediaId: string,
): Promise<string[]> {
  const [layouts, playlists] = await Promise.all([
    tx.get(db.collection(paths.layouts(orgId)).where('mediaIds', 'array-contains', mediaId).limit(5)),
    tx.get(db.collection(paths.playlists(orgId)).where('mediaIds', 'array-contains', mediaId).limit(5)),
  ]);
  return [
    ...layouts.docs.map((d) => `layout “${(d.data() as LayoutDoc).name}”`),
    ...playlists.docs.map((d) => `playlist “${(d.data() as PlaylistDoc).name}”`),
  ];
}

export async function deleteMedia(
  { db, bucket, now }: Deps,
  actor: Actor,
  input: z.infer<typeof DeleteMediaInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'media.delete');
    const ref = db.doc(paths.media(input.orgId, input.mediaId));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Media not found.');
    const media = snap.data() as MediaDoc;
    const usedBy = await mediaUsage(tx, db, input.orgId, input.mediaId);
    if (usedBy.length > 0) {
      throw new HttpsError('failed-precondition', `This file is in use by ${usedBy.join(', ')}. Remove it there first.`);
    }

    tx.delete(ref);
    tx.set(
      db.doc(paths.orgUsage(input.orgId)),
      { storageBytes: FieldValue.increment(-media.storedBytes), updatedAt: at },
      { merge: true },
    );
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'media.deleted',
      target: { type: 'media', id: input.mediaId },
      data: { name: media.name, type: media.type },
    });
  });
  // Binary cleanup after the record is gone; a failure here only leaves orphaned files.
  await bucket.deleteFiles({ prefix: `orgs/${input.orgId}/media/${input.mediaId}/` }).catch(() => undefined);
}

export async function upsertFolder(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof UpsertFolderInput>,
): Promise<{ folderId: string }> {
  return db.runTransaction(async (tx) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'media.upload');
    const ref = input.folderId
      ? db.doc(paths.folder(input.orgId, input.folderId))
      : db.collection(paths.folders(input.orgId)).doc();
    if (input.folderId) {
      if (!(await tx.get(ref)).exists) throw new HttpsError('not-found', 'Folder not found.');
      tx.update(ref, { name: input.name });
    } else {
      const folder: FolderDoc = { id: ref.id, name: input.name, createdAt: now() };
      tx.create(ref, folder);
    }
    return { folderId: ref.id };
  });
}

export async function deleteFolder(
  { db }: Deps,
  actor: Actor,
  input: z.infer<typeof DeleteFolderInput>,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'media.delete');
    const inside = await tx.get(
      db.collection(paths.mediaCol(input.orgId)).where('folderId', '==', input.folderId).limit(1),
    );
    if (!inside.empty) throw new HttpsError('failed-precondition', 'Move or delete the files in this folder first.');
    tx.delete(db.doc(paths.folder(input.orgId, input.folderId)));
  });
}
