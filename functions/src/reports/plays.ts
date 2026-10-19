/**
 * Proof-of-play. Players upload hourly play counts (POST /api/v1/devices/plays); each upload is
 * folded into one summary per screen per day in the organization's time zone
 * (orgs/{orgId}/playStats/{date}_{screenId}), about 24 writes per screen per day. Nothing is
 * stored for organizations whose plan does not include proof-of-play reports. Summaries expire
 * through a Firestore TTL after the plan's retention period.
 */
import {
  HttpsError } from 'firebase-functions/v2/https';
import { FieldValue,
  type DocumentReference,
  type Query } from 'firebase-admin/firestore';
import type { z } from 'zod';
import {
  PLAY_MAX_AGE_DAYS,
  PLAY_REPORT_MAX_DAYS,
  PLAY_REPORT_MAX_ROWS,
  PlayReportBody,
  parsePlayKey,
  paths,
  type DeviceDoc,
  type EntitlementsDoc,
  type OrgDoc,
  type PlaybackReport,
  type PlaybackReportInput,
  type PlayBucket,
  type PlayCounts,
  type PlayKind,
  type PlayStatsDoc,
  type UptimeBucket,
  type UptimeCounts,
  type ScreenDoc,
} from '@wallx-play/shared';
import { authenticate, type ApiRequest, type ApiResult } from '../devices/deviceApi';
import { requireOrgPermission, requireSiteInScope } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { requireFeature } from '../lib/entitlements';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Processed upload ids are remembered this long (players retry within hours, not weeks). */
const BATCH_MEMORY_DAYS = 7;
/** Reports read at most this many daily summaries (screens × days). */
const MAX_DOCS = 20_000;

const fail = (status: number, error: string, message: string): ApiResult => ({ status, body: { error, message } });

/** Local calendar date and hour of a UTC instant in `timeZone`. */
export function localDateHour(ms: number, timeZone: string): { date: string; hour: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour! };
}

/** Groups uploaded buckets into per-day increments (items and local hours). */
export function foldBuckets(buckets: PlayBucket[], timeZone: string): Map<string, { items: Map<string, PlayCounts>; hours: Map<string, PlayCounts>; total: PlayCounts }> {
  const days = new Map<string, { items: Map<string, PlayCounts>; hours: Map<string, PlayCounts>; total: PlayCounts }>();
  const add = (map: Map<string, PlayCounts>, key: string, b: PlayCounts) => {
    const c = map.get(key) ?? { plays: 0, seconds: 0 };
    map.set(key, { plays: c.plays + b.plays, seconds: c.seconds + b.seconds });
  };
  for (const b of buckets) {
    if (b.plays === 0 && b.seconds === 0) continue;
    const { date, hour } = localDateHour(b.hour, timeZone);
    let day = days.get(date);
    if (!day) days.set(date, (day = { items: new Map(), hours: new Map(), total: { plays: 0, seconds: 0 } }));
    add(day.items, `${b.kind}_${b.id}`, b);
    add(day.hours, hour, b);
    day.total = { plays: day.total.plays + b.plays, seconds: day.total.seconds + b.seconds };
  }
  return days;
}

const inc = (c: PlayCounts) => ({ plays: FieldValue.increment(c.plays), seconds: FieldValue.increment(c.seconds) });

/** POST /api/v1/devices/plays — hourly play counts from an authorized player. */
export async function devicePlays(deps: Deps, req: ApiRequest): Promise<ApiResult> {
  const auth = await authenticate(deps, req);
  if ('status' in auth && 'body' in auth) return auth;
  const device = auth as DeviceDoc;
  if (device.status !== 'authorized' || !device.orgId || !device.screenId) {
    return fail(403, 'not_authorized', 'This player is not authorized yet.');
  }
  const parsed = PlayReportBody.safeParse(req.body);
  if (!parsed.success) return fail(400, 'invalid_argument', 'Invalid play report.');
  const { db, now } = deps;
  const at = now();
  const { orgId, screenId } = device;
  // Ignore what a long-offline box kept for weeks, and clocks set in the future.
  const fresh = (hour: number) => hour >= at - PLAY_MAX_AGE_DAYS * DAY && hour <= at + HOUR;
  const buckets = parsed.data.buckets.filter((b) => fresh(b.hour));
  const uptime = parsed.data.uptime.filter((u) => fresh(u.hour));

  const stored = await db.runTransaction(async (tx) => {
    const batchRef = db.doc(paths.playBatch(device.id, parsed.data.batchId));
    const [batch, org, screen, ent] = await Promise.all([
      tx.get(batchRef),
      tx.get(db.doc(paths.org(orgId))),
      tx.get(db.doc(paths.screen(orgId, screenId))),
      tx.get(db.doc(paths.orgEntitlements(orgId))),
    ]);
    if (batch.exists) return (batch.get('stored') as boolean | undefined) ?? false; // a retry: already counted
    const entitlements = ent.data() as EntitlementsDoc | undefined;
    // App store: proof-of-play and diagnostics only for screens that hold those apps.
    const blockedHere = (screen.data() as ScreenDoc | undefined)?.blockedFeatures ?? [];
    const features = screen.exists ? (entitlements?.features ?? []).filter((f) => !blockedHere.includes(f)) : [];
    // Plays only with proof-of-play reports, uptime only with screen diagnostics.
    const plays = features.includes('report.proofOfPlay') ? buckets : [];
    const up = features.includes('screen.diagnostics') ? uptime : [];
    const enabled = plays.length + up.length > 0;
    tx.create(batchRef, { at, stored: enabled, buckets: buckets.length, uptime: uptime.length, expiresAt: new Date(at + BATCH_MEMORY_DAYS * DAY) });
    if (!enabled) return false;
    const timeZone = (org.data() as OrgDoc | undefined)?.timezone || 'Asia/Kolkata';
    const siteId = (screen.data() as ScreenDoc).siteId ?? null;
    const keepDays = entitlements!.limits.retentionDays ?? 730;
    const playDays = foldBuckets(plays, timeZone);
    const upDays = foldUptime(up, timeZone);
    for (const date of new Set([...playDays.keys(), ...upDays.keys()])) {
      const day = playDays.get(date);
      const u = upDays.get(date);
      // Merged increments: the first upload of the day creates the summary.
      tx.set(
        db.doc(paths.playStat(orgId, date, screenId)),
        {
          ...dayBase(date, screenId, siteId, keepDays),
          ...(day
            ? {
                ...inc(day.total),
                items: Object.fromEntries([...day.items].map(([k, c]) => [k, inc(c)])),
                hours: Object.fromEntries([...day.hours].map(([k, c]) => [k, inc(c)])),
              }
            : {}),
          ...(u
            ? {
                onSeconds: FieldValue.increment(u.total.on),
                onlineSeconds: FieldValue.increment(u.total.online),
                uptime: Object.fromEntries([...u.hours].map(([k, c]) => [k, { on: FieldValue.increment(c.on), online: FieldValue.increment(c.online) }])),
              }
            : {}),
          updatedAt: at,
        },
        { merge: true },
      );
    }
    return true;
  });
  return { status: 200, body: { ok: true, stored } };
}

/** Fields every daily summary carries (also written by screen events, see events.ts). */
export function dayBase(date: string, screenId: string, siteId: string | null, keepDays: number) {
  return { date, screenId, siteId, expiresAt: new Date(Date.parse(`${date}T00:00:00Z`) + (keepDays + 1) * DAY) };
}

/** Groups uptime hours into per-day increments (local hours and totals). */
export function foldUptime(buckets: UptimeBucket[], timeZone: string): Map<string, { hours: Map<string, UptimeCounts>; total: UptimeCounts }> {
  const days = new Map<string, { hours: Map<string, UptimeCounts>; total: UptimeCounts }>();
  for (const b of buckets) {
    if (b.on === 0 && b.online === 0) continue;
    const { date, hour } = localDateHour(b.hour, timeZone);
    let day = days.get(date);
    if (!day) days.set(date, (day = { hours: new Map(), total: { on: 0, online: 0 } }));
    const c = day.hours.get(hour) ?? { on: 0, online: 0 };
    day.hours.set(hour, { on: c.on + b.on, online: c.online + b.online });
    day.total = { on: day.total.on + b.on, online: day.total.online + b.online };
  }
  return days;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

/** Playback report for the web app (Playback Reports page and CSV export). */
export async function playbackReport(deps: Deps, actor: Actor, input: z.infer<typeof PlaybackReportInput>): Promise<PlaybackReport> {
  const { db } = deps;
  if (daysBetween(input.from, input.to) > PLAY_REPORT_MAX_DAYS) {
    throw new HttpsError('invalid-argument', `Choose at most ${PLAY_REPORT_MAX_DAYS} days.`);
  }
  const { member, org, entitlements, screen } = await db.runTransaction(async (tx) => {
    const m = await requireOrgPermission(tx, db, actor, input.orgId, 'report.view');
    const [o, e, s] = await Promise.all([
      tx.get(db.doc(paths.org(input.orgId))),
      tx.get(db.doc(paths.orgEntitlements(input.orgId))),
      input.screenId ? tx.get(db.doc(paths.screen(input.orgId, input.screenId))) : Promise.resolve(null),
    ]);
    return { member: m, org: o.data() as OrgDoc, entitlements: e.data() as EntitlementsDoc | undefined, screen: s?.data() as ScreenDoc | undefined };
  });
  if (!entitlements) throw new HttpsError('failed-precondition', 'Organization entitlements are not set up yet.');
  requireFeature(entitlements, 'report.proofOfPlay', 'Proof-of-play reports');
  if (input.siteId) requireSiteInScope(member, input.siteId, 'that site');
  if (input.screenId) {
    if (!screen) throw new HttpsError('not-found', 'Screen not found.');
    requireSiteInScope(member, screen.siteId, 'that screen');
  }

  let q: Query = db.collection(paths.playStats(input.orgId)).where('date', '>=', input.from).where('date', '<=', input.to);
  if (input.screenId) q = q.where('screenId', '==', input.screenId);
  else if (input.siteId) q = q.where('siteId', '==', input.siteId);
  const snap = await q.limit(MAX_DOCS + 1).get();
  if (snap.size > MAX_DOCS) throw new HttpsError('resource-exhausted', 'Too much data for one report: choose fewer days, a site or a screen.');
  const scope = member.siteScope ?? [];
  // Days that only carry uptime or diagnostics (no plays) are not part of this report.
  const docs = snap.docs
    .map((d) => d.data() as PlayStatsDoc)
    .filter((d) => (d.plays ?? 0) > 0 && (!scope.length || (!!d.siteId && scope.includes(d.siteId))));

  const add = (a: PlayCounts, b: PlayCounts) => ({ plays: a.plays + (b.plays ?? 0), seconds: a.seconds + (b.seconds ?? 0) });
  const zero = (): PlayCounts => ({ plays: 0, seconds: 0 });
  const content = new Map<string, PlayCounts & { screens: Set<string> }>();
  const screens = new Map<string, PlayCounts>();
  const days = new Map<string, PlayCounts>();
  const byHour = Array.from({ length: 24 }, () => 0);
  const rows: PlaybackReport['rows'] = [];
  let totals = zero();
  for (const d of docs) {
    totals = add(totals, d);
    screens.set(d.screenId, add(screens.get(d.screenId) ?? zero(), d));
    days.set(d.date, add(days.get(d.date) ?? zero(), d));
    for (const [h, c] of Object.entries(d.hours ?? {})) byHour[Number(h)] = (byHour[Number(h)] ?? 0) + (c.plays ?? 0);
    for (const [key, c] of Object.entries(d.items ?? {})) {
      const parsed = parsePlayKey(key);
      if (!parsed) continue;
      const entry = content.get(key) ?? { ...zero(), screens: new Set<string>() };
      content.set(key, { ...add(entry, c), screens: entry.screens.add(d.screenId) });
      if (rows.length < PLAY_REPORT_MAX_ROWS) rows.push({ date: d.date, screenId: d.screenId, ...parsed, plays: c.plays ?? 0, seconds: c.seconds ?? 0 });
    }
  }
  const rowCount = docs.reduce((n, d) => n + Object.keys(d.items ?? {}).length, 0);

  // Names now (renamed items show their current name; deleted ones show none).
  const ids = (kind: PlayKind) => [...content.keys()].map(parsePlayKey).filter((p) => p?.kind === kind).map((p) => p!.id);
  const names = new Map<string, string>();
  const load = async (refs: DocumentReference[], key: (id: string) => string) => {
    for (let i = 0; i < refs.length; i += 300) {
      for (const s of await db.getAll(...refs.slice(i, i + 300))) {
        const name = (s.data() as { name?: string } | undefined)?.name;
        if (name) names.set(key(s.id), name);
      }
    }
  };
  await Promise.all([
    load(ids('media').map((id) => db.doc(paths.media(input.orgId, id))), (id) => `media_${id}`),
    load(ids('layout').map((id) => db.doc(paths.layout(input.orgId, id))), (id) => `layout_${id}`),
    // Taps are counted per touch page: show the page's (layout's) name.
    load(ids('tap').map((id) => db.doc(paths.layout(input.orgId, id))), (id) => `tap_${id}`),
    load([...screens.keys()].map((id) => db.doc(paths.screen(input.orgId, id))), (id) => `screen_${id}`),
  ]);
  const screenSites = new Map(docs.map((d) => [d.screenId, d.siteId]));

  const byContent = [...content].map(([key, c]) => {
    const { kind, id } = parsePlayKey(key)!;
    return { kind, id, name: names.get(key) ?? '', plays: c.plays, seconds: c.seconds, screens: c.screens.size };
  });
  return {
    from: input.from,
    to: input.to,
    timezone: org.timezone,
    totals: { ...totals, screens: screens.size, items: content.size },
    byContent: byContent.sort((a, b) => b.plays - a.plays || b.seconds - a.seconds),
    byScreen: [...screens]
      .map(([screenId, c]) => ({ screenId, name: names.get(`screen_${screenId}`) ?? '', siteId: screenSites.get(screenId) ?? null, ...c }))
      .sort((a, b) => b.plays - a.plays),
    byDay: [...days].map(([date, c]) => ({ date, ...c })).sort((a, b) => a.date.localeCompare(b.date)),
    byHour,
    rows: rows.sort((a, b) => a.date.localeCompare(b.date) || a.screenId.localeCompare(b.screenId)),
    rowsTruncated: rowCount > PLAY_REPORT_MAX_ROWS,
  };
}
