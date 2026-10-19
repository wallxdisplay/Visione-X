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
  type SyncGroupDoc,
  type SyncMember,
  type EntitlementsDoc,
  type ScreenTouch,
  WIDGET_SCREEN_FEATURES,
  type AppDoc,
  type FeatureKey,
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
  /** The sync group the screen plays in (enabled, with this screen as a member), if any. */
  sync?: { group: SyncGroupDoc; member: SyncMember } | null;
  /** Touch kiosk settings (only when the plan has interactive.touch). */
  touch?: ScreenTouch | null;
  /** App store: features this screen may not use (screen apps it does not hold). */
  blocked?: readonly FeatureKey[];
  /** Name of the app selling each feature, for the notice shown instead of a widget. */
  appNames?: Partial<Record<FeatureKey, string>>;
  /** Collects the blocked features the content actually uses (to tell whoever publishes). */
  missing?: Set<FeatureKey>;
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

  // In a sync group the group's playlist replaces the screen's schedules (emergencies still win).
  const group = src.sync && src.playlists.has(src.sync.group.playlistId) && !(src.blocked ?? []).includes('screen.multiSync') ? src.sync : null;
  const defaultPlaylistId = group
    ? group.group.playlistId
    : src.screen.defaultPlaylistId && src.playlists.has(src.screen.defaultPlaylistId)
      ? src.screen.defaultPlaylistId
      : null;

  // App store: a widget for an app this screen does not hold shows a short notice instead.
  const blocked = new Set(src.blocked ?? []);
  const gate = <T extends { kind: string }>(content: T): T => {
    if (content.kind !== 'widget') return content;
    const feature = WIDGET_SCREEN_FEATURES[(content as unknown as { widget: { type: string } }).widget.type];
    if (!feature || !blocked.has(feature)) return content;
    src.missing?.add(feature);
    const app = src.appNames?.[feature] ?? 'This app';
    return { kind: 'widget', widget: { type: 'text', text: `${app} is not enabled on this screen`, style: { color: '#94A3B8', align: 'center', fontScale: 0.12 } } } as unknown as T;
  };
  const cleanItems = (items: PlaylistItem[]) =>
    items
      .filter((i) =>
        i.content.kind === 'media' ? playable(i.content.mediaId) : i.content.kind === 'layout' ? src.layouts.has(i.content.layoutId) : true,
      )
      .map((i) => ({ ...i, content: gate(i.content) }));
  const touchOk = !blocked.has('interactive.touch');
  const cleanZone = (z: Zone): Zone => {
    const c = z.content;
    if (c.kind === 'media' && !playable(c.mediaId)) return { ...z, content: { kind: 'empty' } };
    if (c.kind === 'playlist' && !src.playlists.has(c.playlistId)) return { ...z, content: { kind: 'empty' } };
    const { action, ...rest } = z;
    return { ...(touchOk && action ? { ...rest, action } : rest), content: gate(c) };
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
    schedules: group ? [] : rules,
    defaultPlaylistId,
    fallbackMediaId: null,
    emergency,
    assets,
    liveChannels: liveChannelsOf(layouts, playlists),
    dataSources: dataSourcesOf(layouts, playlists),
    rotation: src.screen.rotation ?? 0,
    touch:
      !group && src.touch && src.layouts.has(src.touch.homeLayoutId) && !(src.blocked ?? []).includes('interactive.touch')
        ? { homeLayoutId: src.touch.homeLayoutId, idleSec: src.touch.idleSec, attract: src.touch.attract }
        : null,
    sync: group
      ? {
          groupId: group.group.id,
          mode: group.group.mode,
          anchor: group.group.anchor,
          tile: group.group.mode === 'wall' ? { rows: group.group.rows, cols: group.group.cols, row: group.member.row, col: group.member.col } : null,
        }
      : null,
  });
}

/** Touch kiosks: how deep tap links are followed, and how many pages a screen gets at most. */
const MAX_PAGE_DEPTH = 6;
const MAX_PAGES = 60;

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
  missing?: Set<FeatureKey>,
): Promise<Manifest> {
  const blocked = screen.blockedFeatures ?? [];
  const schedules = (await db.collection(paths.schedules(orgId)).where('enabled', '==', true).get()).docs
    .map((d) => d.data() as ScheduleDoc)
    .filter((s) => targetsScreen(s, screen));

  const emergencies = (await db.collection(paths.emergencies(orgId)).where('active', '==', true).get()).docs.map(
    (d) => d.data() as EmergencyDoc,
  );
  const emergency = activeEmergencyFor(emergencies, screen, now());

  // Playlists from schedules + default + emergency, then layouts they contain, then zone playlists.
  const groupDoc = screen.syncGroupId && !blocked.includes('screen.multiSync') ? ((await db.doc(paths.syncGroup(orgId, screen.syncGroupId)).get()).data() as SyncGroupDoc | undefined) : undefined;
  const member = groupDoc?.enabled ? groupDoc.members.find((m) => m.screenId === screen.id) : undefined;
  const sync = groupDoc && member ? { group: groupDoc, member } : null;

  const playlistIds = new Set(schedules.map((s) => s.playlistId));
  if (screen.defaultPlaylistId) playlistIds.add(screen.defaultPlaylistId);
  if (sync) playlistIds.add(sync.group.playlistId);
  if (emergency?.content.kind === 'playlist') playlistIds.add(emergency.content.playlistId);
  const playlists = await getMany<PlaylistDoc>(db, (id) => paths.playlist(orgId, id), playlistIds);
  // Touch screens also get their home page and every page a tap can reach (a few levels deep).
  const ent = screen.touch ? ((await db.doc(paths.orgEntitlements(orgId)).get()).data() as EntitlementsDoc | undefined) : undefined;
  const touch = screen.touch && !sync && ent?.features.includes('interactive.touch') && !blocked.includes('interactive.touch') ? screen.touch : null;
  const layouts = await getMany<LayoutDoc>(db, (id) => paths.layout(orgId, id), [
    ...[...playlists.values()].flatMap((p) => p.layoutIds),
    ...(touch ? [touch.homeLayoutId] : []),
  ]);
  for (let depth = 0; touch && depth < MAX_PAGE_DEPTH && layouts.size < MAX_PAGES; depth++) {
    const next = [...new Set([...layouts.values()].flatMap((l) => l.layoutIds ?? []))].filter((id) => !layouts.has(id));
    if (!next.length) break;
    for (const [id, l] of await getMany<LayoutDoc>(db, (lid) => paths.layout(orgId, lid), next.slice(0, MAX_PAGES - layouts.size))) layouts.set(id, l);
  }
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

  // App names for the notice shown in place of widgets this screen has no app for.
  const appNames: Partial<Record<FeatureKey, string>> = {};
  if (blocked.length) {
    for (const d of (await db.collection(paths.apps()).get()).docs) {
      const app = d.data() as AppDoc;
      for (const k of app.featureKeys) appNames[k] ??= app.name;
    }
  }
  return assembleManifest({ orgId, screen, version, now: now(), schedules, playlists, layouts, media, assetUrls, emergency, sync, touch, blocked, appNames, missing });
}
