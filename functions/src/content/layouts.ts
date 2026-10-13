import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import {
  AVAILABLE_WIDGETS,
  SENSOR_WIDGETS,
  widgetBindings,
  layoutRefs,
  playlistRefs,
  type ContentRefs,
  type Widget,
} from '@wallx-play/layout-spec';
import {
  paths,
  type DeleteLayoutInput,
  type DeletePlaylistInput,
  type DataSourceDoc,
  type EntitlementsDoc,
  type LayoutDoc,
  type MediaDoc,
  type PlaylistDoc,
  type SaveLayoutInput,
  type SavePlaylistInput,
  type ScheduleDoc,
} from '@wallx-play/shared';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';
import { userAudit } from './media';

/** Widgets must be released and in the plan. */
function checkWidgets(refs: ContentRefs, entitlements: EntitlementsDoc) {
  for (const type of refs.widgetTypes) {
    if (!(AVAILABLE_WIDGETS as readonly string[]).includes(type)) {
      throw new HttpsError('invalid-argument', `The “${type}” widget is not available yet.`);
    }
  }
  if (refs.widgetTypes.length > 0) requireFeature(entitlements, 'widget.core', 'Widgets');
  // Sensor widgets, or any widget showing a sensor value (e.g. a table cell).
  if (refs.sensors.length > 0 || refs.widgetTypes.some((t) => (SENSOR_WIDGETS as readonly string[]).includes(t))) {
    requireFeature(entitlements, 'sensor.esp32', 'Sensor widgets');
  }
  if (refs.widgetTypes.includes('weather')) requireFeature(entitlements, 'widget.weather', 'The weather widget');
  if (refs.widgetTypes.includes('rss')) requireFeature(entitlements, 'widget.rss', 'The RSS widget');
}

/** Weather and RSS widgets must point at a data source of the same type in this org (reads only). */
async function checkDataSources(tx: Transaction, db: Firestore, orgId: string, content: Array<{ widget: Widget }>) {
  const wanted = content.flatMap(({ widget }) => (widget.type === 'weather' || widget.type === 'rss' ? [{ id: widget.dataSourceId, type: widget.type }] : []));
  const snaps = await Promise.all(wanted.map((w) => tx.get(db.doc(paths.dataSource(orgId, w.id)))));
  snaps.forEach((snap, i) => {
    const ds = snap.data() as DataSourceDoc | undefined;
    if (!ds) throw new HttpsError('invalid-argument', 'A weather or RSS widget points at a data source that no longer exists.');
    if (ds.type !== wanted[i]!.type) throw new HttpsError('invalid-argument', `“${ds.name}” is not a ${wanted[i]!.type} data source.`);
  });
}

/** Sensor widgets must point at channels that exist in this org (reads only). */
async function checkSensors(tx: Transaction, db: Firestore, orgId: string, content: Array<{ widget: Widget }>, refs: ContentRefs) {
  const bindings = content.flatMap(({ widget }) => widgetBindings(widget).map((b) => b.binding));
  if (bindings.some((b) => b.source !== 'sensor')) {
    throw new HttpsError('invalid-argument', 'Data source bindings are not available yet.');
  }
  const snaps = await Promise.all(refs.sensors.map((r) => tx.get(db.doc(paths.sensorChannel(orgId, r.sourceId, r.field)))));
  if (snaps.some((s) => !s.exists)) {
    throw new HttpsError('invalid-argument', 'A sensor widget points at a sensor channel that no longer exists.');
  }
}

const widgetsOf = <T extends { content: { kind: string } }>(xs: T[]) =>
  xs.flatMap((x) => (x.content.kind === 'widget' ? [x.content as unknown as { widget: Widget }] : []));
const sensorDeviceIds = (refs: ContentRefs) => [...new Set(refs.sensors.map((r) => r.sourceId))];

/** Every referenced media item must exist in this org and not have failed processing. */
async function checkMedia(tx: Transaction, db: Firestore, orgId: string, mediaIds: string[]) {
  const snaps = await Promise.all(mediaIds.map((id) => tx.get(db.doc(paths.media(orgId, id)))));
  for (const snap of snaps) {
    if (!snap.exists) throw new HttpsError('invalid-argument', 'A selected media file no longer exists.');
    const media = snap.data() as MediaDoc;
    if (media.status === 'failed') {
      throw new HttpsError('invalid-argument', `“${media.name}” failed to process and cannot be used.`);
    }
  }
}

function meta(actor: Actor, at: number, existing: { createdBy: string; createdAt: number } | undefined) {
  return {
    createdBy: existing?.createdBy ?? actor.uid,
    createdAt: existing?.createdAt ?? at,
    updatedBy: actor.uid,
    updatedAt: at,
  };
}

export async function saveLayout(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SaveLayoutInput>,
): Promise<{ layoutId: string }> {
  const at = now();
  const ref = input.layoutId
    ? db.doc(paths.layout(input.orgId, input.layoutId))
    : db.collection(paths.layouts(input.orgId)).doc();
  const refs = layoutRefs(input.layout);

  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'layout.edit');
    const entitlements = await readEntitlements(tx, db, input.orgId);
    if (input.layout.zones.length > 1) requireFeature(entitlements, 'layout.multiZone', 'Multi-zone layouts');
    checkWidgets(refs, entitlements);
    const existing = input.layoutId ? await tx.get(ref) : null;
    if (existing && !existing.exists) throw new HttpsError('not-found', 'Layout not found.');
    await checkMedia(tx, db, input.orgId, refs.mediaIds);
    await checkSensors(tx, db, input.orgId, widgetsOf(input.layout.zones), refs);
    await checkDataSources(tx, db, input.orgId, widgetsOf(input.layout.zones));

    // A playlist shown inside a zone may not itself contain layouts (no nesting/cycles).
    const playlists = await Promise.all(refs.playlistIds.map((id) => tx.get(db.doc(paths.playlist(input.orgId, id)))));
    for (const snap of playlists) {
      if (!snap.exists) throw new HttpsError('invalid-argument', 'A selected playlist no longer exists.');
      const playlist = snap.data() as PlaylistDoc;
      if (playlist.layoutIds.length > 0) {
        throw new HttpsError(
          'invalid-argument',
          `Playlist “${playlist.name}” contains layouts, so it cannot be placed inside a zone.`,
        );
      }
    }

    const doc: LayoutDoc = {
      id: ref.id,
      specVersion: 1,
      name: input.layout.name,
      canvas: input.layout.canvas,
      zones: input.layout.zones,
      mediaIds: refs.mediaIds,
      playlistIds: refs.playlistIds,
      layoutIds: [],
      sensorDeviceIds: sensorDeviceIds(refs),
      dataSourceIds: refs.dataSourceIds,
      ...meta(actor, at, existing?.data() as LayoutDoc | undefined),
    };
    tx.set(ref, doc);
    if (!existing) {
      audit(input.orgId, {
        at,
        ...userAudit(actor),
        orgId: input.orgId,
        action: 'layout.created',
        target: { type: 'layout', id: ref.id },
        data: { name: doc.name },
      });
    }
  });
  return { layoutId: ref.id };
}

export async function deleteLayout(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof DeleteLayoutInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'layout.edit');
    const ref = db.doc(paths.layout(input.orgId, input.layoutId));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Layout not found.');
    const usedBy = await tx.get(
      db.collection(paths.playlists(input.orgId)).where('layoutIds', 'array-contains', input.layoutId).limit(5),
    );
    if (!usedBy.empty) {
      const names = usedBy.docs.map((d) => `“${(d.data() as PlaylistDoc).name}”`).join(', ');
      throw new HttpsError('failed-precondition', `This layout is used in playlist ${names}. Remove it there first.`);
    }
    tx.delete(ref);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'layout.deleted',
      target: { type: 'layout', id: input.layoutId },
      data: { name: (snap.data() as LayoutDoc).name },
    });
  });
}

export async function savePlaylist(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof SavePlaylistInput>,
): Promise<{ playlistId: string }> {
  const at = now();
  const ref = input.playlistId
    ? db.doc(paths.playlist(input.orgId, input.playlistId))
    : db.collection(paths.playlists(input.orgId)).doc();
  const refs = playlistRefs(input.items);
  const ids = new Set(input.items.map((i) => i.id));
  if (ids.size !== input.items.length) throw new HttpsError('invalid-argument', 'Duplicate playlist item ids.');

  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'playlist.edit');
    const entitlements = await readEntitlements(tx, db, input.orgId);
    checkWidgets(refs, entitlements);
    const existing = input.playlistId ? await tx.get(ref) : null;
    if (existing && !existing.exists) throw new HttpsError('not-found', 'Playlist not found.');
    await checkMedia(tx, db, input.orgId, refs.mediaIds);
    await checkSensors(tx, db, input.orgId, widgetsOf(input.items), refs);
    await checkDataSources(tx, db, input.orgId, widgetsOf(input.items));

    const layouts = await Promise.all(refs.layoutIds.map((id) => tx.get(db.doc(paths.layout(input.orgId, id)))));
    if (layouts.some((s) => !s.exists)) throw new HttpsError('invalid-argument', 'A selected layout no longer exists.');
    if (refs.layoutIds.length > 0 && input.playlistId) {
      const inZone = await tx.get(
        db.collection(paths.layouts(input.orgId)).where('playlistIds', 'array-contains', input.playlistId).limit(1),
      );
      if (!inZone.empty) {
        throw new HttpsError(
          'failed-precondition',
          `This playlist is shown inside layout “${(inZone.docs[0]!.data() as LayoutDoc).name}”, so it cannot contain layouts.`,
        );
      }
    }

    const doc: PlaylistDoc = {
      id: ref.id,
      name: input.name,
      items: input.items,
      totalDurationSec: input.items.reduce((sum, i) => sum + i.durationSec, 0),
      mediaIds: refs.mediaIds,
      playlistIds: [],
      layoutIds: refs.layoutIds,
      sensorDeviceIds: sensorDeviceIds(refs),
      dataSourceIds: refs.dataSourceIds,
      ...meta(actor, at, existing?.data() as PlaylistDoc | undefined),
    };
    tx.set(ref, doc);
    if (!existing) {
      audit(input.orgId, {
        at,
        ...userAudit(actor),
        orgId: input.orgId,
        action: 'playlist.created',
        target: { type: 'playlist', id: ref.id },
        data: { name: doc.name },
      });
    }
  });
  return { playlistId: ref.id };
}

export async function deletePlaylist(
  { db, now }: Deps,
  actor: Actor,
  input: z.infer<typeof DeletePlaylistInput>,
): Promise<void> {
  const at = now();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'playlist.edit');
    const ref = db.doc(paths.playlist(input.orgId, input.playlistId));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Playlist not found.');
    const [layouts, schedules] = await Promise.all([
      tx.get(db.collection(paths.layouts(input.orgId)).where('playlistIds', 'array-contains', input.playlistId).limit(5)),
      tx.get(db.collection(paths.schedules(input.orgId)).where('playlistId', '==', input.playlistId).limit(5)),
    ]);
    const usedBy = [
      ...layouts.docs.map((d) => `layout “${(d.data() as LayoutDoc).name}”`),
      ...schedules.docs.map((d) => `schedule “${(d.data() as ScheduleDoc).name}”`),
    ];
    if (usedBy.length > 0) {
      throw new HttpsError('failed-precondition', `This playlist is used by ${usedBy.join(', ')}. Remove it there first.`);
    }
    tx.delete(ref);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'playlist.deleted',
      target: { type: 'playlist', id: input.playlistId },
      data: { name: (snap.data() as PlaylistDoc).name },
    });
  });
}
