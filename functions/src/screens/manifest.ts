import type { Firestore } from 'firebase-admin/firestore';
import {
  Manifest,
  SPEC_VERSION,
  dataSourcesOf,
  liveChannelsOf,
  type Layout,
  type PlaylistItem,
  type ScheduleRule,
  type Zone,
} from '@wallx-play/layout-spec';
import {
  emergencyPlaylistId,
  paths,
  type EmergencyDoc,
  type EmergencyTarget,
  type LayoutDoc,
  type MediaDoc,
  type PlaylistDoc,
  type ScheduleDoc,
  type ScheduleTarget,
  type ScreenDoc,
} from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import { downloadUrl } from '../lib/storageUrl';

type TargetScreen = Pick<ScreenDoc, 'id' | 'siteId' | 'groupIds'>;

/** Does a schedule or emergency target include this screen? */
export function matchesTarget(t: ScheduleTarget | EmergencyTarget, screen: TargetScreen): boolean {
  if (t.kind === 'all') return true;
  if (t.kind === 'sites') return !!screen.siteId && t.ids.includes(screen.siteId);
  if (t.kind === 'screens') return t.ids.includes(screen.id);
  return t.ids.some((id) => screen.groupIds.includes(id));
}

export const targetsScreen = (schedule: ScheduleDoc, screen: TargetScreen) => matchesTarget(schedule.target, screen);

/** The emergency that applies to a screen now: the most recently started active one. */
export function activeEmergencyFor(emergencies: EmergencyDoc[], screen: TargetScreen, now: number): EmergencyDoc | null {
  return (
    emergencies
      .filter((e) => e.active && (e.expiresAt === null || e.expiresAt > now) && matchesTarget(e.target, screen))
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
  );
}

export interface ManifestSources {
  orgId: string;
  screen: ScreenDoc;
  version: number;
  now: number;
  schedules: ScheduleDoc[];
  playlists: Map<string, PlaylistDoc>;
  layouts: Map<string, LayoutDoc>;
  media: Map<string, MediaDoc>;
  /** Download URL per media id (only for media that is ready). */
  assetUrls: Map<string, string>;
  /** Active emergency override for this screen, if any. */
  emergency?: EmergencyDoc | null;
}

/**
 * Builds the self-contained package a screen plays from (pure; unit-tested).
 * Anything not ready or missing is dropped here, so the player never references an asset it
 * cannot download: playlist items are skipped, zones fall back to empty.
 */
export function assembleManifest(src: ManifestSources): Manifest {
  const playable = (mediaId: string) => src.assetUrls.has(mediaId);

  const rules: ScheduleRule[] = src.schedules
    .filter((s) => s.enabled && targetsScreen(s, src.screen) && src.playlists.has(s.playlistId))
    .map((s) => ({
      id: s.id,
      priority: s.priority,
      timezone: s.timezone,
      startDate: s.startDate,
      endDate: s.endDate,
      daysOfWeek: s.daysOfWeek,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      playlistId: s.playlistId,
    }));

  const defaultPlaylistId =
    src.screen.defaultPlaylistId && src.playlists.has(src.screen.defaultPlaylistId) ? src.screen.defaultPlaylistId : null;

  const cleanItems = (items: PlaylistItem[]) =>
    items.filter((i) =>
      i.content.kind === 'media' ? playable(i.content.mediaId) : i.content.kind === 'layout' ? src.layouts.has(i.content.layoutId) : true,
    );
  const cleanZone = (z: Zone): Zone => {
    const c = z.content;
    if (c.kind === 'media' && !playable(c.mediaId)) return { ...z, content: { kind: 'empty' } };
    if (c.kind === 'playlist' && !src.playlists.has(c.playlistId)) return { ...z, content: { kind: 'empty' } };
    return z;
  };

  const layouts: Layout[] = [...src.layouts.values()].map((l) => ({
    specVersion: SPEC_VERSION,
    id: l.id,
    name: l.name,
    canvas: l.canvas,
    zones: l.zones.map(cleanZone),
  }));
  const playlists = [...src.playlists.values()].map((p) => ({ id: p.id, items: cleanItems(p.items) }));

  // Emergency override: a referenced playlist, or a synthetic full-screen message playlist.
  let emergency: Manifest['emergency'] = null;
  const e = src.emergency;
  if (e) {
    if (e.content.kind === 'message') {
      const pid = emergencyPlaylistId(e.id);
      playlists.push({
        id: pid,
        items: [
          {
            id: 'message',
            durationSec: 3600,
            transition: 'none',
            content: {
              kind: 'widget',
              widget: {
                type: 'text',
                text: e.content.text,
                style: { color: e.content.color, background: e.content.background, bold: true, align: 'center', fontScale: 0.12 },
              },
            },
          },
        ],
      });
      emergency = { id: e.id, playlistId: pid, expiresAt: e.expiresAt };
    } else if (src.playlists.has(e.content.playlistId)) {
      emergency = { id: e.id, playlistId: e.content.playlistId, expiresAt: e.expiresAt };
    }
  }

  const assets = [...src.assetUrls.entries()].map(([mediaId, url]) => {
    const m = src.media.get(mediaId)!;
    const d = m.display!;
    return { mediaId, url, sha256: d.sha256!, bytes: d.bytes, mimeType: d.mimeType };
  });

  return Manifest.parse({
    specVersion: SPEC_VERSION,
    orgId: src.orgId,
    screenId: src.screen.id,
    version: src.version,
    generatedAt: src.now,
    layouts,
    playlists,
    schedules: rules,
    defaultPlaylistId,
    fallbackMediaId: null,
    emergency,
    assets,
    liveChannels: liveChannelsOf(layouts, playlists),
    dataSources: dataSourcesOf(layouts, playlists),
    rotation: src.screen.rotation ?? 0,
  });
}

async function getMany<T>(db: Firestore, pathFor: (id: string) => string, ids: Iterable<string>): Promise<Map<string, T>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const snaps = await db.getAll(...unique.map((id) => db.doc(pathFor(id))));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data() as T]));
}

/** Loads everything a screen needs and assembles its manifest. */
export async function compileManifest(
  { db, bucket, now }: Deps,
  orgId: string,
  screen: ScreenDoc,
  version: number,
): Promise<Manifest> {
  const schedules = (await db.collection(paths.schedules(orgId)).where('enabled', '==', true).get()).docs
    .map((d) => d.data() as ScheduleDoc)
    .filter((s) => targetsScreen(s, screen));

  const emergencies = (await db.collection(paths.emergencies(orgId)).where('active', '==', true).get()).docs.map(
    (d) => d.data() as EmergencyDoc,
  );
  const emergency = activeEmergencyFor(emergencies, screen, now());

  // Playlists from schedules + default + emergency, then layouts they contain, then zone playlists.
  const playlistIds = new Set(schedules.map((s) => s.playlistId));
  if (screen.defaultPlaylistId) playlistIds.add(screen.defaultPlaylistId);
  if (emergency?.content.kind === 'playlist') playlistIds.add(emergency.content.playlistId);
  const playlists = await getMany<PlaylistDoc>(db, (id) => paths.playlist(orgId, id), playlistIds);
  const layouts = await getMany<LayoutDoc>(db, (id) => paths.layout(orgId, id), [...playlists.values()].flatMap((p) => p.layoutIds));
  const zonePlaylistIds = [...layouts.values()].flatMap((l) => l.playlistIds).filter((id) => !playlists.has(id));
  for (const [id, p] of await getMany<PlaylistDoc>(db, (pid) => paths.playlist(orgId, pid), zonePlaylistIds)) playlists.set(id, p);

  const mediaIds = [...playlists.values(), ...layouts.values()].flatMap((x) => x.mediaIds);
  const media = await getMany<MediaDoc>(db, (id) => paths.media(orgId, id), mediaIds);
  const assetUrls = new Map<string, string>();
  await Promise.all(
    [...media.values()]
      .filter((m) => m.status === 'ready' && m.display?.sha256)
      .map(async (m) => assetUrls.set(m.id, await downloadUrl(bucket, m.display!.path))),
  );

  return assembleManifest({ orgId, screen, version, now: now(), schedules, playlists, layouts, media, assetUrls, emergency });
}
