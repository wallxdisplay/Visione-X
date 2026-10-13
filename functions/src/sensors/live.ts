/**
 * Live sensor values for players (GET /api/v1/devices/live and /devices/live/history).
 * A screen only receives the channels its published manifest binds (`liveChannels`), so a
 * player can never read other sensors of the org.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { LiveChannel } from '@wallx-play/layout-spec';
import {
  HISTORY_MAX_POINTS,
  downsample,
  isSensorOnline,
  liveRefreshSec,
  paths,
  readingBucketIds,
  type DeviceDoc,
  type DeviceHistoryResponse,
  type DeviceLiveResponse,
  type EntitlementsDoc,
  type LiveValueDto,
  type OrgDoc,
  type ReadingBucketDoc,
  type SensorChannelDoc,
  type SensorDeviceDoc,
} from '@wallx-play/shared';
import type { Deps } from '../lib/context';
import { authenticate, type ApiRequest, type ApiResult } from '../devices/deviceApi';

const fail = (status: number, error: string, message: string): ApiResult => ({ status, body: { error, message } });

/** Authenticated, authorized screen → its org and bound channels. */
async function boundChannels(deps: Deps, req: ApiRequest): Promise<{ orgId: string; channels: LiveChannel[] } | ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  const device = auth as DeviceDoc;
  if (device.status !== 'authorized' || !device.orgId || !device.screenId) {
    return fail(403, 'not_authorized', 'This player is not authorized yet.');
  }
  const [org, manifest] = await deps.db.getAll(
    deps.db.doc(paths.org(device.orgId)),
    deps.db.doc(paths.screenManifest(device.orgId, device.screenId)),
  );
  if ((org?.data() as OrgDoc | undefined)?.status !== 'active') return fail(403, 'org_inactive', 'The organization is not active.');
  const channels = (manifest?.get('liveChannels') as LiveChannel[] | undefined) ?? [];
  return { orgId: device.orgId, channels };
}

/** The org's live refresh rate, cached per instance (plan changes apply within a few minutes). */
const REFRESH_CACHE_MS = 5 * 60_000;
const refreshCache = new Map<string, { at: number; sec: number }>();

async function refreshSecFor(deps: Deps, orgId: string): Promise<number> {
  const at = deps.now();
  const hit = refreshCache.get(orgId);
  if (hit && at - hit.at < REFRESH_CACHE_MS) return hit.sec;
  const ent = (await deps.db.doc(paths.orgEntitlements(orgId)).get()).data() as EntitlementsDoc | undefined;
  const sec = liveRefreshSec(ent?.limits ?? {});
  refreshCache.set(orgId, { at, sec });
  return sec;
}

export const resetRefreshCache = () => refreshCache.clear();

async function getAllMap<T>(db: Firestore, paths: string[]): Promise<Map<string, T>> {
  if (paths.length === 0) return new Map();
  const snaps = await db.getAll(...paths.map((p) => db.doc(p)));
  return new Map(snaps.filter((s) => s.exists).map((s) => [s.ref.path, s.data() as T]));
}

export async function deviceLive(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const bound = await boundChannels(deps, req);
  if ('status' in bound) return bound;
  const { orgId, channels } = bound;
  const at = deps.now();
  const deviceIds = [...new Set(channels.map((c) => c.sourceId))];
  const [devices, docs, refreshSec] = await Promise.all([
    getAllMap<SensorDeviceDoc>(deps.db, deviceIds.map((id) => paths.sensorDevice(orgId, id))),
    getAllMap<SensorChannelDoc>(deps.db, channels.map((c) => paths.sensorChannel(orgId, c.sourceId, c.field))),
    refreshSecFor(deps, orgId),
  ]);
  const values: LiveValueDto[] = channels.map((c) => {
    const ch = docs.get(paths.sensorChannel(orgId, c.sourceId, c.field));
    const dev = devices.get(paths.sensorDevice(orgId, c.sourceId));
    return {
      sourceId: c.sourceId,
      field: c.field,
      name: ch?.name ?? c.field,
      value: ch?.latest?.value ?? null,
      ts: ch?.latest?.ts ?? null,
      staleAfterSec: ch?.staleAfterSec ?? 600,
      deviceOnline: !!dev && dev.status === 'active' && isSensorOnline(dev, at),
      unit: ch?.unit ?? '',
      valueType: ch?.valueType ?? 'number',
    };
  });
  const body: DeviceLiveResponse = { serverTime: at, values, refreshSec };
  return { status: 200, body };
}

export async function deviceLiveHistory(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const bound = await boundChannels(deps, req);
  if ('status' in bound) return bound;
  const { orgId, channels } = bound;
  const at = deps.now();
  const charted = channels.filter((c) => c.historyMinutes);
  const series = await Promise.all(
    charted.map(async (c) => {
      const from = at - c.historyMinutes! * 60_000;
      const buckets = await getAllMap<ReadingBucketDoc>(
        deps.db,
        readingBucketIds(from, at).map((b) => paths.sensorReading(orgId, c.sourceId, c.field, b)),
      );
      const points = [...buckets.values()]
        .flatMap((b) => b.points)
        .filter((p) => p.t >= from && p.t <= at)
        .sort((a, b) => a.t - b.t)
        .map((p): [number, number] => [p.t, p.v]);
      return { sourceId: c.sourceId, field: c.field, points: downsample(points, HISTORY_MAX_POINTS) };
    }),
  );
  const body: DeviceHistoryResponse = { serverTime: at, series };
  return { status: 200, body };
}
