/**
 * Screen analytics for the web app: how much of the time each screen's player was running and
 * online, errors and offline alerts, and plays, per day and per screen. Built from the daily
 * summaries (playStats) that players (uptime, plays) and diagnostics events (errors, offline)
 * fill. Screens on players before 0.14.0 send no uptime: they show no share instead of 0%.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { Query } from 'firebase-admin/firestore';
import type { z } from 'zod';
import {
  PLAY_REPORT_MAX_DAYS,
  paths,
  type EntitlementsDoc,
  type OrgDoc,
  type PlayStatsDoc,
  type ScreenAnalytics,
  type ScreenAnalyticsInput,
  type ScreenAnalyticsRow,
  type ScreenDoc,
} from '@wallx-play/shared';
import { requireOrgPermission, requireSiteInScope } from '../lib/authz';
import type { Actor, Deps } from '../lib/context';
import { requireFeature } from '../lib/entitlements';

const DAY = 86_400_000;
const MAX_DOCS = 20_000;

/** Offset of `timeZone` from UTC at `ms` (local wall time minus UTC), in ms. */
function zoneOffset(ms: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - ms;
}

/** UTC instant when local `date` (YYYY-MM-DD) starts in `timeZone`. */
export function localDayStart(date: string, timeZone: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  return guess - zoneOffset(guess - zoneOffset(guess, timeZone), timeZone);
}

/** Dates from..to inclusive (YYYY-MM-DD). */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Seconds of local `date` during which the screen existed, up to `now`. */
export function expectedSeconds(date: string, timeZone: string, createdAt: number, now: number): number {
  const start = Math.max(localDayStart(date, timeZone), createdAt);
  const end = Math.min(localDayStart(date, timeZone) + DAY, now);
  return Math.max(0, Math.round((end - start) / 1000));
}

interface Acc {
  on: number;
  online: number;
  expected: number;
  errors: number;
  offline: number;
  plays: number;
  hasUptime: boolean;
}
const empty = (): Acc => ({ on: 0, online: 0, expected: 0, errors: 0, offline: 0, plays: 0, hasUptime: false });
const share = (part: number, whole: number) => (whole > 0 ? Math.min(1, part / whole) : null);
const row = (a: Acc): ScreenAnalyticsRow => ({
  onShare: a.hasUptime ? share(a.on, a.expected) : null,
  onlineShare: a.hasUptime ? share(a.online, a.expected) : null,
  errors: a.errors,
  offline: a.offline,
  plays: a.plays,
});

export async function screenAnalytics(deps: Deps, actor: Actor, input: z.infer<typeof ScreenAnalyticsInput>): Promise<ScreenAnalytics> {
  const { db, now } = deps;
  const dates = datesBetween(input.from, input.to);
  if (dates.length > PLAY_REPORT_MAX_DAYS) throw new HttpsError('invalid-argument', `Choose at most ${PLAY_REPORT_MAX_DAYS} days.`);
  const { member, org, entitlements } = await db.runTransaction(async (tx) => {
    const m = await requireOrgPermission(tx, db, actor, input.orgId, 'report.view');
    const [o, e] = await Promise.all([tx.get(db.doc(paths.org(input.orgId))), tx.get(db.doc(paths.orgEntitlements(input.orgId)))]);
    return { member: m, org: o.data() as OrgDoc, entitlements: e.data() as EntitlementsDoc | undefined };
  });
  if (!entitlements) throw new HttpsError('failed-precondition', 'Organization entitlements are not set up yet.');
  requireFeature(entitlements, 'screen.diagnostics', 'Screen analytics and diagnostics');
  if (input.siteId) requireSiteInScope(member, input.siteId, 'that site');
  const timeZone = org.timezone || 'Asia/Kolkata';
  const scope = member.siteScope ?? [];
  const inScope = (siteId: string | null) => !scope.length || (!!siteId && scope.includes(siteId));

  // Screens in view: one, a site's, or all the member may see.
  let screens: ScreenDoc[];
  if (input.screenId) {
    const s = (await db.doc(paths.screen(input.orgId, input.screenId)).get()).data() as ScreenDoc | undefined;
    if (!s) throw new HttpsError('not-found', 'Screen not found.');
    requireSiteInScope(member, s.siteId, 'that screen');
    screens = [s];
  } else {
    let sq: Query = db.collection(paths.screens(input.orgId));
    if (input.siteId) sq = sq.where('siteId', '==', input.siteId);
    screens = (await sq.get()).docs.map((d) => d.data() as ScreenDoc).filter((s) => inScope(s.siteId));
  }
  screens = screens.filter((s) => s.status === 'authorized');
  const ids = new Set(screens.map((s) => s.id));

  let q: Query = db.collection(paths.playStats(input.orgId)).where('date', '>=', input.from).where('date', '<=', input.to);
  if (input.screenId) q = q.where('screenId', '==', input.screenId);
  else if (input.siteId) q = q.where('siteId', '==', input.siteId);
  const snap = await q.limit(MAX_DOCS + 1).get();
  if (snap.size > MAX_DOCS) throw new HttpsError('resource-exhausted', 'Too much data: choose fewer days or a site.');

  const at = now();
  const perScreen = new Map(screens.map((s) => [s.id, empty()]));
  const perDay = new Map(dates.map((d) => [d, empty()]));
  const withUptime = new Set<string>();
  for (const d of snap.docs.map((x) => x.data() as PlayStatsDoc)) {
    if (!ids.has(d.screenId)) continue; // removed screens, or outside the member's sites
    const s = perScreen.get(d.screenId)!;
    const day = perDay.get(d.date);
    const add = (a: Acc) => {
      a.on += d.onSeconds ?? 0;
      a.online += d.onlineSeconds ?? 0;
      a.errors += d.errors ?? 0;
      a.offline += d.offline ?? 0;
      a.plays += d.plays ?? 0;
    };
    add(s);
    if (day) add(day);
    if (d.onSeconds !== undefined) withUptime.add(d.screenId);
  }
  // Expected running time only for screens that report uptime (others have no share).
  for (const s of screens) {
    if (!withUptime.has(s.id)) continue;
    const acc = perScreen.get(s.id)!;
    acc.hasUptime = true;
    for (const date of dates) {
      const secs = expectedSeconds(date, timeZone, s.createdAt ?? 0, at);
      acc.expected += secs;
      const day = perDay.get(date)!;
      day.expected += secs;
      day.hasUptime = true;
    }
  }
  const total = empty();
  for (const a of perScreen.values()) {
    total.on += a.on;
    total.online += a.online;
    total.expected += a.expected;
    total.errors += a.errors;
    total.offline += a.offline;
    total.plays += a.plays;
    total.hasUptime ||= a.hasUptime;
  }

  return {
    from: input.from,
    to: input.to,
    timezone: timeZone,
    totals: { ...row(total), screens: screens.length, screensWithData: withUptime.size },
    byDay: dates.filter((d) => d <= new Date(at + zoneOffset(at, timeZone)).toISOString().slice(0, 10)).map((date) => ({ date, ...row(perDay.get(date)!) })),
    byScreen: screens
      .map((s) => ({
        screenId: s.id,
        name: s.name,
        siteId: s.siteId ?? null,
        status: s.status,
        lastSeen: s.lastSeen ?? null,
        appVersion: s.health?.appVersion ?? null,
        ...row(perScreen.get(s.id)!),
      }))
      // Most attention needed first: lowest uptime, then most errors.
      .sort((a, b) => (a.onShare ?? 2) - (b.onShare ?? 2) || b.errors - a.errors || a.name.localeCompare(b.name)),
  };
}
