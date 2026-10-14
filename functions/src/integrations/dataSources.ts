/**
 * Data sources (weather and air quality places, RSS feeds) per organization, and their values
 * for previews (web) and screens (GET /api/v1/devices/data).
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { z } from 'zod';
import type { ManifestDataSource } from '@wallx-play/layout-spec';
import {
  paths,
  type DataSourceDoc,
  type DataSourceRefInput,
  type DataSourceValue,
  type DeviceDataResponse,
  type DeviceDoc,
  type GeocodeInput,
  type GeocodeResult,
  type LayoutDoc,
  type OrgDoc,
  type PlaylistDoc,
  type RssData,
  type SaveDataSourceInput,
  type TestRssInput,
} from '@wallx-play/shared';
import { userAudit } from '../content/media';
import { authenticate, type ApiRequest, type ApiResult } from '../devices/deviceApi';
import { auditedTransaction } from '../lib/audit';
import { requireActiveOrgPermission, requireOrgPermission } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { readEntitlements, requireFeature } from '../lib/entitlements';
import { fetchRss, getDataSourceValue, providerMessage } from './cache';
import { geocode, weatherAttribution } from './weather';

// Air quality is part of the weather feature (same provider and place search).
const FEATURE = { weather: 'widget.weather', rss: 'widget.rss', air_quality: 'widget.weather' } as const;
const LABEL = { weather: 'Weather', rss: 'RSS feeds', air_quality: 'Air quality' } as const;

export async function saveDataSource({ db, now }: Deps, actor: Actor, input: z.infer<typeof SaveDataSourceInput>): Promise<{ dataSourceId: string }> {
  const at = now();
  const ref = input.dataSourceId ? db.doc(paths.dataSource(input.orgId, input.dataSourceId)) : db.collection(paths.dataSources(input.orgId)).doc();
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'integration.manage');
    requireFeature(await readEntitlements(tx, db, input.orgId), FEATURE[input.type], LABEL[input.type]);
    const existing = input.dataSourceId ? ((await tx.get(ref)).data() as DataSourceDoc | undefined) : undefined;
    if (input.dataSourceId && !existing) throw new HttpsError('not-found', 'Data source not found.');
    if (existing && existing.type !== input.type) throw new HttpsError('invalid-argument', 'The type of a data source cannot be changed.');
    const count = existing ? null : await tx.get(db.collection(paths.dataSources(input.orgId)).count());
    if (count && count.data().count >= 100) throw new HttpsError('resource-exhausted', 'An organization can have at most 100 data sources.');
    const doc = {
      id: ref.id,
      name: input.name,
      type: input.type,
      config: input.config,
      createdBy: existing?.createdBy ?? actor.uid,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      lastFetch: existing?.lastFetch ?? null,
    } as DataSourceDoc;
    tx.set(ref, doc);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: existing ? 'dataSource.updated' : 'dataSource.created',
      target: { type: 'dataSource', id: ref.id },
      data: { name: input.name, type: input.type },
    });
  });
  return { dataSourceId: ref.id };
}

export async function deleteDataSource({ db, now }: Deps, actor: Actor, input: z.infer<typeof DataSourceRefInput>): Promise<void> {
  const at = now();
  const ref = db.doc(paths.dataSource(input.orgId, input.dataSourceId));
  await auditedTransaction(db, [input.orgId], async (tx, audit) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'integration.manage');
    const ds = (await tx.get(ref)).data() as DataSourceDoc | undefined;
    if (!ds) throw new HttpsError('not-found', 'Data source not found.');
    const [layouts, playlists] = await Promise.all([
      tx.get(db.collection(paths.layouts(input.orgId)).where('dataSourceIds', 'array-contains', input.dataSourceId).limit(5)),
      tx.get(db.collection(paths.playlists(input.orgId)).where('dataSourceIds', 'array-contains', input.dataSourceId).limit(5)),
    ]);
    const usedBy = [
      ...layouts.docs.map((d) => `layout “${(d.data() as LayoutDoc).name}”`),
      ...playlists.docs.map((d) => `playlist “${(d.data() as PlaylistDoc).name}”`),
    ];
    if (usedBy.length) throw new HttpsError('failed-precondition', `This data source is shown in ${usedBy.join(', ')}. Remove it there first.`);
    tx.delete(ref);
    audit(input.orgId, {
      at,
      ...userAudit(actor),
      orgId: input.orgId,
      action: 'dataSource.deleted',
      target: { type: 'dataSource', id: input.dataSourceId },
      data: { name: ds.name, type: ds.type },
    });
  });
}

/** Place search for weather and air quality data sources. */
export async function geocodePlace(deps: Deps, actor: Actor, input: z.infer<typeof GeocodeInput>): Promise<{ results: GeocodeResult[]; attribution: string }> {
  const { db } = deps;
  await db.runTransaction(async (tx) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'integration.manage');
    requireFeature(await readEntitlements(tx, db, input.orgId), 'widget.weather', 'Weather');
  });
  try {
    return { results: await geocode(deps, input.query), attribution: weatherAttribution() };
  } catch (err) {
    throw new HttpsError('unavailable', providerMessage(err));
  }
}

/** Fetches a feed before it is saved, so the user sees it works. Not cached. */
export async function testRssFeed(deps: Deps, actor: Actor, input: z.infer<typeof TestRssInput>): Promise<RssData> {
  const { db } = deps;
  await db.runTransaction(async (tx) => {
    await requireActiveOrgPermission(tx, db, actor, input.orgId, 'integration.manage');
    requireFeature(await readEntitlements(tx, db, input.orgId), 'widget.rss', 'RSS feeds');
  });
  try {
    const data = await fetchRss(deps, input.config);
    return { ...data, items: data.items.slice(0, input.config.maxItems) };
  } catch (err) {
    throw new HttpsError('failed-precondition', providerMessage(err));
  }
}

/** Current value for previews in the web app (Studio, Integrations page). */
export async function previewDataSource(deps: Deps, actor: Actor, input: z.infer<typeof DataSourceRefInput>): Promise<DataSourceValue> {
  const { db } = deps;
  const ds = await db.runTransaction(async (tx) => {
    await requireOrgPermission(tx, db, actor, input.orgId, 'screen.view');
    return (await tx.get(db.doc(paths.dataSource(input.orgId, input.dataSourceId)))).data() as DataSourceDoc | undefined;
  });
  if (!ds) throw new HttpsError('not-found', 'Data source not found.');
  return getDataSourceValue(deps, input.orgId, ds);
}

const fail = (status: number, error: string, message: string): ApiResult => ({ status, body: { error, message } });

/** GET /api/v1/devices/data — values of the data sources the screen's manifest uses. */
export async function deviceData(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  const device = auth as DeviceDoc;
  if (device.status !== 'authorized' || !device.orgId || !device.screenId) return fail(403, 'not_authorized', 'This player is not authorized yet.');
  const { db } = deps;
  const [org, manifest] = await db.getAll(db.doc(paths.org(device.orgId)), db.doc(paths.screenManifest(device.orgId, device.screenId)));
  if ((org?.data() as OrgDoc | undefined)?.status !== 'active') return fail(403, 'org_inactive', 'The organization is not active.');
  const bound = (manifest?.get('dataSources') as ManifestDataSource[] | undefined) ?? [];
  const snaps = bound.length ? await db.getAll(...bound.map((b) => db.doc(paths.dataSource(device.orgId!, b.id)))) : [];
  const sources = await Promise.all(
    snaps.filter((s) => s.exists).map((s) => getDataSourceValue(deps, device.orgId!, s.data() as DataSourceDoc)),
  );
  const body: DeviceDataResponse = { serverTime: deps.now(), sources };
  return { status: 200, body };
}
